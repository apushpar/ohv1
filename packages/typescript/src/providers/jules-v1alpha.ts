import { ProviderError, classifyHttpError } from "../errors.js";
import { pollingStream } from "../streaming.js";
import type { Artifact, Event, ProviderId, ProviderCapabilities, ReplayToken, Session, SessionOptions, SessionPage, SessionStatus } from "../types.js";
import { ReplayToken as RT } from "../types.js";
import type { SupportsPlanApproval } from "./extensions.js";

const BASE = "https://jules.googleapis.com/v1alpha";

const STATUS_MAP: Record<string, SessionStatus> = {
  QUEUED: "queued",
  PLANNING: "queued",
  AWAITING_PLAN_APPROVAL: "awaiting_input",
  AWAITING_USER_FEEDBACK: "awaiting_input",
  IN_PROGRESS: "in_progress",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

async function req(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "X-Goog-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : null,
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const hdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => { hdrs[k] = v; });
    throw classifyHttpError(resp.status, data, "jules", hdrs);
  }
  return data;
}

export class JulesV1AlphaProvider implements SupportsPlanApproval {
  readonly id: ProviderId = "jules";
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    cancellation: true,
    listSessions: true,
    sendMessage: true,
    planApproval: true,
    toolResults: false,
    fileUpload: false,
  };

  constructor(private readonly apiKey: string) {}

  private toSession(data: Record<string, unknown>): Session {
    const rawStatus =
      (data["state"] as string | undefined) ??
      (data["status"] as string | undefined) ??
      "QUEUED";
    const status: SessionStatus = STATUS_MAP[rawStatus] ?? "in_progress";
    const artifacts: Artifact[] = [];
    for (const out of (data["outputs"] as Array<Record<string, unknown>> | undefined) ?? []) {
      const pr = out["pullRequest"] as Record<string, unknown> | undefined;
      if (pr) {
        artifacts.push({
          kind: "pull_request",
          provider: "jules",
          ...(pr["url"] !== undefined ? { url: pr["url"] as string } : {}),
          ...(pr["title"] !== undefined ? { title: pr["title"] as string } : {}),
        });
      }
    }
    const nameStr = (data["name"] as string | undefined) ?? "";
    const id = nameStr.includes("/")
      ? nameStr.split("/").pop()!
      : (data["id"] as string | undefined) ?? nameStr;
    return {
      id,
      provider: "jules",
      status,
      createdAt: new Date((data["createTime"] as string | undefined) ?? new Date().toISOString()).toISOString(),
      updatedAt: new Date((data["updateTime"] as string | undefined) ?? new Date().toISOString()).toISOString(),
      artifacts,
      replayToken: RT._encode({}),
    };
  }

  async createSession(opts: SessionOptions): Promise<Session> {
    const po = opts.providerOptions ?? {};
    const body: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.title) body["title"] = opts.title;
    if (
      opts.source &&
      (opts.source.kind === "github" || opts.source.kind === "gitlab" || opts.source.kind === "bitbucket")
    ) {
      const rest = opts.source.uri.split("://")[1]!;
      const [repoPart, uriB] = rest.split("@", 2) as [string, string | undefined];
      const slashIdx = repoPart.indexOf("/");
      const owner = repoPart.slice(0, slashIdx);
      const repo = repoPart.slice(slashIdx + 1);
      const sourceName = `sources/github/${owner}/${repo}`;
      let branch: string | undefined = opts.source.branch ?? uriB;
      if (!branch) {
        // Jules requires startingBranch on every request — fetch the default
        const srcData = await req(this.apiKey, "GET", `/${sourceName}`);
        const githubRepo = srcData["githubRepo"] as Record<string, unknown> | undefined;
        const defaultBranch = githubRepo?.["defaultBranch"] as Record<string, unknown> | undefined;
        branch = defaultBranch?.["displayName"] as string | undefined;
      }
      body["sourceContext"] = {
        source: sourceName,
        githubRepoContext: { startingBranch: branch },
      };
    }
    if (po["require_plan_approval"]) body["requirePlanApproval"] = true;
    if (po["auto_create_pr"]) body["automationMode"] = "AUTO_CREATE_PR";
    const data = await req(this.apiKey, "POST", "/sessions", body);
    return this.toSession(data);
  }

  async getSession(sessionId: string, _replayToken?: ReplayToken): Promise<Session> {
    const data = await req(this.apiKey, "GET", `/sessions/${sessionId}`);
    return this.toSession(data);
  }

  async *streamEvents(
    sessionId: string,
    replayToken?: ReplayToken,
    sinceSeq = 0,
  ): AsyncIterableIterator<Event> {
    const seenIds = new Set<string>();
    const apiKey = this.apiKey;

    const fetchSession = () => this.getSession(sessionId, replayToken);

    const fetchNewEvents = async (
      cursor: string | undefined,
    ): Promise<[Event[], string | undefined]> => {
      const params = new URLSearchParams({ pageSize: "100" });
      if (cursor) params.set("pageToken", cursor);
      let data: Record<string, unknown>;
      try {
        data = await req(apiKey, "GET", `/sessions/${sessionId}/activities?${params}`);
      } catch (err) {
        // Jules returns 404 on /activities while session is still QUEUED
        if (err instanceof ProviderError && err.kind === "not_found") {
          return [[], cursor];
        }
        throw err;
      }
      const activities = (data["activities"] as Array<Record<string, unknown>> | undefined) ?? [];
      const nextToken = data["nextPageToken"] as string | undefined;
      const events: Event[] = [];
      for (const act of activities) {
        const actId = (act["name"] as string | undefined) ?? "";
        if (seenIds.has(actId)) continue;
        seenIds.add(actId);
        const ev = activityToEvent(act, sessionId);
        if (ev) events.push(ev);
      }
      return [events, nextToken];
    };

    yield* pollingStream({
      provider: "jules",
      sessionId,
      fetchSession,
      fetchNewEvents,
      pollBase: 2000,
      pollCap: 15000,
    });
  }

  async cancelSession(sessionId: string, _replayToken?: ReplayToken): Promise<void> {
    await req(this.apiKey, "DELETE", `/sessions/${sessionId}`);
  }

  async sendMessage(sessionId: string, message: string, _replayToken?: ReplayToken): Promise<void> {
    await req(this.apiKey, "POST", `/sessions/${sessionId}:sendMessage`, { prompt: message });
  }

  async listSessions(limit = 20, cursor?: string): Promise<SessionPage> {
    const params = new URLSearchParams({ pageSize: String(limit) });
    if (cursor) params.set("pageToken", cursor);
    const data = await req(this.apiKey, "GET", `/sessions?${params}`);
    const sessions = (
      (data["sessions"] as Array<Record<string, unknown>> | undefined) ?? []
    ).map((s) => this.toSession(s));
    const nextCursor = data["nextPageToken"] as string | undefined;
    return {
      sessions,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      provider: "jules",
    };
  }

  async approvePlan(sessionId: string, _replayToken?: ReplayToken): Promise<void> {
    await req(this.apiKey, "POST", `/sessions/${sessionId}:approvePlan`, {});
  }
}

function activityToEvent(act: Record<string, unknown>, sessionId: string): Event | null {
  const tsStr = (act["createTime"] as string | undefined) ?? new Date().toISOString();
  const ts = new Date(tsStr).toISOString();

  // Activity type is indicated by which field is present — there is no "kind" field.
  if ("agentMessaged" in act) {
    const am = act["agentMessaged"] as Record<string, unknown> | undefined;
    return {
      kind: "message",
      sessionId,
      provider: "jules",
      ts,
      seq: 0,
      data: { text: (am?.["agentMessage"] as string | undefined) ?? "" },
      raw: act,
    };
  }
  if ("progressUpdated" in act) {
    const pu = act["progressUpdated"] as Record<string, unknown> | undefined;
    return {
      kind: "tool_activity",
      sessionId,
      provider: "jules",
      ts,
      seq: 0,
      data: {
        tool: (pu?.["tool"] as string | undefined) ?? "",
        summary: (pu?.["summary"] as string | undefined) ?? "",
        title: (pu?.["title"] as string | undefined) ?? "",
      },
      raw: act,
    };
  }
  if ("planGenerated" in act) {
    const pg = act["planGenerated"] as Record<string, unknown> | undefined;
    const plan = pg?.["plan"] as Record<string, unknown> | undefined;
    return {
      kind: "provider_event",
      sessionId,
      provider: "jules",
      ts,
      seq: 0,
      data: {
        type: "plan_proposed",
        steps: (plan?.["steps"] as unknown[] | undefined) ?? [],
      },
      raw: act,
    };
  }
  if ("userMessaged" in act) {
    const um = act["userMessaged"] as Record<string, unknown> | undefined;
    return {
      kind: "provider_event",
      sessionId,
      provider: "jules",
      ts,
      seq: 0,
      data: {
        type: "user_message",
        text: (um?.["userMessage"] as string | undefined) ?? "",
      },
      raw: act,
    };
  }
  // passthrough for planApproved, sessionCompleted, and anything else
  const actType =
    Object.keys(act).find(
      (k) => !["name", "createTime", "originator", "id", "artifacts"].includes(k),
    ) ?? "unknown";
  return {
    kind: "provider_event",
    sessionId,
    provider: "jules",
    ts,
    seq: 0,
    data: { type: actType, raw: act },
    raw: act,
  };
}
