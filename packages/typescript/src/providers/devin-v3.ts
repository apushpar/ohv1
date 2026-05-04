import { classifyHttpError, ProviderError } from "../errors.js";
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

const STATUS_MAP: Record<string, SessionStatus> = {
  running: "in_progress",
  exit: "completed",
  error: "failed",
  suspended: "paused",
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
    throw classifyHttpError(resp.status, data, "devin", hdrs);
  }
  return data;
}

export class DevinV3Provider {
  readonly id: ProviderId = "devin";
  readonly capabilities: ProviderCapabilities = {
    streaming: false,
    cancellation: true,
    listSessions: true,
    sendMessage: true,
    planApproval: false,
    toolResults: false,
    fileUpload: false,
  };

  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    readonly orgId: string,
  ) {
    if (!orgId) {
      throw new ProviderError(
        "invalid_request",
        "DEVIN_ORG_ID is required for the Devin provider",
        "devin",
        false,
      );
    }
    this.base = `https://api.devin.ai/v3/organizations/${orgId}`;
  }

  private buildPrompt(opts: SessionOptions): string {
    const po = opts.providerOptions ?? {};
    const parts: string[] = [];
    if (opts.source && opts.source.uri !== "none:") {
      parts.push(`Repository: ${opts.source.uri}\n`);
    }
    const skills = (po["skills"] as Array<{ name: string; content: string }> | undefined) ?? [];
    if (skills.length > 0) {
      const blocks = ["---", "# Context"];
      for (const sk of skills) {
        blocks.push(`## ${sk.name}\n${sk.content}`);
      }
      blocks.push("---");
      parts.push(blocks.join("\n") + "\n");
    }
    parts.push(opts.prompt);
    if (po["auto_create_pr"]) {
      parts.push("\n\nWhen complete, open a pull request with your changes.");
    }
    return parts.join("");
  }

  private toSession(data: Record<string, unknown>): Session {
    const sessionId =
      (data["session_id"] as string | undefined) ?? (data["id"] as string | undefined) ?? "";
    const rawStatus = (data["status"] as string | undefined) ?? "running";
    const status: SessionStatus = STATUS_MAP[rawStatus] ?? "in_progress";
    const artifacts: Artifact[] = [];
    for (const att of (data["attachments"] as Array<Record<string, unknown>> | undefined) ?? []) {
      artifacts.push({
        kind: "file",
        provider: "devin",
        url: att["url"] as string | undefined,
        name: att["name"] as string | undefined,
        data: att,
      });
    }
    const prUrl = data["pull_request_url"] as string | undefined;
    if (prUrl) artifacts.push({ kind: "pull_request", provider: "devin", url: prUrl });
    const token = RT._encode({
      session_id: sessionId,
      org_id: this.orgId,
      url: (data["url"] as string | undefined) ?? "",
    });
    const tsStr = (data["created_at"] as string | undefined) ?? new Date().toISOString();
    return {
      id: sessionId,
      provider: "devin",
      status,
      createdAt: new Date(tsStr).toISOString(),
      updatedAt: new Date((data["updated_at"] as string | undefined) ?? tsStr).toISOString(),
      artifacts,
      replayToken: token,
    };
  }

  async createSession(opts: SessionOptions): Promise<Session> {
    const po = opts.providerOptions ?? {};
    if (po["mcp_servers"]) {
      console.debug("devin: mcp_servers in providerOptions is not supported and will be ignored");
    }
    const body: Record<string, unknown> = { prompt: this.buildPrompt(opts) };
    if (opts.idempotencyKey) body["idempotency_key"] = opts.idempotencyKey;
    if (po["create_as_user_id"]) body["create_as_user_id"] = po["create_as_user_id"];
    const data = await req(this.apiKey, "POST", `${this.base}/sessions`, body);
    return this.toSession(data);
  }

  async getSession(sessionId: string, _replayToken?: ReplayToken): Promise<Session> {
    const data = await req(this.apiKey, "GET", `${this.base}/sessions/${sessionId}`);
    return this.toSession(data);
  }

  async *streamEvents(
    sessionId: string,
    replayToken?: ReplayToken,
    _sinceSeq = 0,
  ): AsyncIterableIterator<Event> {
    const seenMsgIndices = new Set<number>();
    const seenAttIds = new Set<string>();
    const self = this;

    const fetchSession = () => self.getSession(sessionId, replayToken);

    const fetchNewEvents = async (
      _cursor: string | undefined,
    ): Promise<[Event[], string | undefined]> => {
      const events: Event[] = [];

      const msgData = await req(self.apiKey, "GET", `${self.base}/sessions/${sessionId}/messages`);
      const messages = (msgData["messages"] as Array<Record<string, unknown>> | undefined) ?? [];
      for (let i = 0; i < messages.length; i++) {
        if (seenMsgIndices.has(i)) continue;
        seenMsgIndices.add(i);
        const msg = messages[i]!;
        const text = (msg["message"] as string | undefined) ?? (msg["text"] as string | undefined) ?? "";
        if (text) {
          events.push({
            kind: "message",
            sessionId,
            provider: "devin",
            ts: new Date((msg["created_at"] as string | undefined) ?? Date.now()).toISOString(),
            seq: 0,
            data: { text },
            raw: msg,
          });
        }
      }

      const attData = await req(self.apiKey, "GET", `${self.base}/sessions/${sessionId}/attachments`);
      const attachments = (attData["attachments"] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const att of attachments) {
        const attId = (att["id"] as string | undefined) ?? "";
        if (seenAttIds.has(attId)) continue;
        seenAttIds.add(attId);
        const artifact: Artifact = {
          kind: "file",
          provider: "devin",
          url: att["url"] as string | undefined,
          name: att["name"] as string | undefined,
          data: att,
        };
        events.push({
          kind: "artifact",
          sessionId,
          provider: "devin",
          ts: new Date((att["created_at"] as string | undefined) ?? Date.now()).toISOString(),
          seq: 0,
          data: { artifact },
          raw: att,
        });
      }

      return [events, undefined];
    };

    yield* pollingStream({ provider: "devin", sessionId, fetchSession, fetchNewEvents });
  }

  async cancelSession(sessionId: string, _replayToken?: ReplayToken): Promise<void> {
    await req(this.apiKey, "DELETE", `${this.base}/sessions/${sessionId}`);
  }

  async sendMessage(sessionId: string, message: string, _replayToken?: ReplayToken): Promise<void> {
    await req(this.apiKey, "POST", `${this.base}/sessions/${sessionId}/messages`, { message });
  }

  async listSessions(limit = 20, cursor?: string): Promise<SessionPage> {
    const url = new URL(`${this.base}/sessions`);
    url.searchParams.set("first", String(limit));
    if (cursor) url.searchParams.set("after", cursor);
    const data = await req(this.apiKey, "GET", url.toString());
    const sessions = ((data["sessions"] as Array<Record<string, unknown>> | undefined) ?? []).map(
      (s) => this.toSession(s),
    );
    return { sessions, nextCursor: data["end_cursor"] as string | undefined, provider: "devin" };
  }
}
