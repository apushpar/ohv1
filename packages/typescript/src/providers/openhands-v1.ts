import { classifyHttpError, UnsupportedCapability } from "../errors.js";
import { pollingStream } from "../streaming.js";
import type {
  Artifact,
  Event,
  ProviderId,
  ProviderCapabilities,
  ReplayToken,
  Session,
  SessionOptions,
  SessionPage,
  SessionStatus,
} from "../types.js";
import { ReplayToken as RT } from "../types.js";

const BASE = "https://app.all-hands.dev";

const STATUS_MAP: Record<string, SessionStatus> = {
  finished: "completed",
  error: "failed",
  stuck: "failed",
  waiting_for_confirmation: "awaiting_input",
  running: "in_progress",
  starting: "in_progress",
  ready: "in_progress",
};

async function req(
  apiKey: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = resp.ok ? ((await resp.json()) as Record<string, unknown>) : {};
  if (!resp.ok) {
    const hdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => { hdrs[k] = v; });
    throw classifyHttpError(resp.status, data, "openhands", hdrs);
  }
  return data;
}

export class OpenHandsV1Provider {
  readonly id: ProviderId = "openhands";
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    cancellation: false,
    listSessions: true,
    sendMessage: false,
    planApproval: false,
    toolResults: false,
    fileUpload: false,
  };

  constructor(private readonly apiKey: string) {}

  private toSession(data: Record<string, unknown>, token?: ReplayToken): Session {
    const convId =
      (data["conversation_id"] as string | undefined) ?? (data["id"] as string | undefined) ?? "";
    const rawStatus = (data["status"] as string | undefined) ?? "running";
    const status: SessionStatus = STATUS_MAP[rawStatus] ?? "in_progress";
    const artifacts: Artifact[] = [];
    const prUrl = data["pull_request_url"] as string | undefined;
    if (prUrl) artifacts.push({ kind: "pull_request", provider: "openhands", url: prUrl });
    const effectiveToken =
      token ??
      RT._encode({
        conversation_id: convId,
        start_task_id: (data["start_task_id"] as string | undefined) ?? "",
      });
    const tsStr = (data["created_at"] as string | undefined) ?? new Date().toISOString();
    return {
      id: convId,
      provider: "openhands",
      status,
      createdAt: new Date(tsStr).toISOString(),
      updatedAt: new Date((data["updated_at"] as string | undefined) ?? tsStr).toISOString(),
      artifacts,
      replayToken: effectiveToken,
    };
  }

  private async fetchConversation(convId: string): Promise<Record<string, unknown>> {
    const url = new URL(`${BASE}/api/v1/app-conversations`);
    url.searchParams.set("ids", convId);
    const convs = await req(this.apiKey, "GET", url.toString());
    const arr = convs as unknown as Array<Record<string, unknown>>;
    return arr[0] ?? {};
  }

  private async waitForReady(startTaskId: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      const url = new URL(`${BASE}/api/v1/app-conversations/start-tasks`);
      url.searchParams.set("ids", startTaskId);
      const tasks = (await req(this.apiKey, "GET", url.toString())) as unknown as Array<Record<string, unknown>>;
      const task = tasks[0] ?? {};
      if (task["status"] === "READY") return (task["conversation_id"] as string | undefined) ?? "";
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("OpenHands conversation did not become ready");
  }

  async createSession(opts: SessionOptions): Promise<Session> {
    const po = opts.providerOptions ?? {};
    const body: Record<string, unknown> = {
      initial_message: { role: "user", content: opts.prompt },
    };
    if (opts.source && (opts.source.kind === "github" || opts.source.kind === "gitlab" || opts.source.kind === "bitbucket")) {
      const rest = opts.source.uri.split("://")[1]!.split("@")[0]!;
      body["selected_repository"] = rest;
    }
    if (po["mcp_servers"]) body["mcp_servers"] = po["mcp_servers"];
    if (po["model_name"]) body["model_name"] = po["model_name"];

    const resp = await req(this.apiKey, "POST", `${BASE}/api/v1/app-conversations`, body);
    const startTaskId = (resp["start_task_id"] as string | undefined) ?? "";
    const convId = await this.waitForReady(startTaskId);
    const token = RT._encode({ conversation_id: convId, start_task_id: startTaskId });
    const data = await this.fetchConversation(convId);
    return this.toSession({ ...data, start_task_id: startTaskId }, token);
  }

  async getSession(sessionId: string, replayToken?: ReplayToken): Promise<Session> {
    const data = await this.fetchConversation(sessionId);
    return this.toSession(data, replayToken);
  }

  async *streamEvents(
    sessionId: string,
    replayToken?: ReplayToken,
    _sinceSeq = 0,
  ): AsyncIterableIterator<Event> {
    let lastStatus: string | undefined;
    const self = this;

    const fetchSession = () => self.getSession(sessionId, replayToken);

    const fetchNewEvents = async (
      _cursor: string | undefined,
    ): Promise<[Event[], string | undefined]> => {
      const session = await self.getSession(sessionId, replayToken);
      const events: Event[] = [];
      const reversedMap: Record<SessionStatus, string> = {
        completed: "finished",
        failed: "error",
        awaiting_input: "waiting_for_confirmation",
        in_progress: "running",
        queued: "queued",
        paused: "paused",
        cancelled: "cancelled",
      };
      const currentRaw = reversedMap[session.status] ?? session.status;
      if (currentRaw !== lastStatus) {
        lastStatus = currentRaw;
        if (currentRaw === "waiting_for_confirmation") {
          events.push({
            kind: "requires_input",
            sessionId,
            provider: "openhands",
            ts: new Date().toISOString(),
            seq: 0,
            data: { question: "Agent needs confirmation" },
          });
        } else if (!["running", "starting", "ready"].includes(currentRaw)) {
          events.push({
            kind: "provider_event",
            sessionId,
            provider: "openhands",
            ts: new Date().toISOString(),
            seq: 0,
            data: { type: "status_transition", status: currentRaw },
          });
        }
      }
      return [events, undefined];
    };

    yield* pollingStream({ provider: "openhands", sessionId, fetchSession, fetchNewEvents });
  }

  async cancelSession(_sessionId: string, _replayToken?: ReplayToken): Promise<void> {
    throw new UnsupportedCapability("openhands", "cancelSession");
  }

  async sendMessage(sessionId: string, message: string, _replayToken?: ReplayToken): Promise<void> {
    await req(this.apiKey, "POST", `${BASE}/api/v1/app-conversations/${sessionId}/messages`, {
      role: "user",
      content: message,
    });
  }

  async listSessions(limit = 20, cursor?: string): Promise<SessionPage> {
    const url = new URL(`${BASE}/api/v1/app-conversations/search`);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("next_page_id", cursor);
    const data = (await req(this.apiKey, "GET", url.toString())) as Record<string, unknown>;
    const convs = (data["conversations"] as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      sessions: convs.map((c) => this.toSession(c)),
      nextCursor: data["next_page_id"] as string | undefined,
      provider: "openhands",
    };
  }
}
