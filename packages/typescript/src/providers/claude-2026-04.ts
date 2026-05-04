import { classifyHttpError } from "../errors.js";
import { claudeSseStream } from "../streaming.js";
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
import type { SupportsFileUpload, SupportsToolResults } from "./extensions.js";

const BASE = "https://api.anthropic.com";
const BETA = "managed-agents-2026-04-01";
const API_VERSION = "2023-06-01";

const STATUS_MAP: Record<string, SessionStatus> = {
  active: "in_progress",
  idle: "completed",
  error: "failed",
  cancelled: "cancelled",
};

const EXTRA_HEADERS = {
  "anthropic-version": API_VERSION,
  "anthropic-beta": BETA,
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
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      ...EXTRA_HEADERS,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = resp.ok ? ((await resp.json()) as Record<string, unknown>) : {};
  if (!resp.ok) {
    const hdrs: Record<string, string> = {};
    resp.headers.forEach((v, k) => { hdrs[k] = v; });
    throw classifyHttpError(resp.status, data, "claude", hdrs);
  }
  return data;
}

export class Claude202604Provider implements SupportsToolResults, SupportsFileUpload {
  readonly id: ProviderId = "claude";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    cancellation: true,
    listSessions: true,
    sendMessage: true,
    planApproval: false,
    toolResults: true,
    fileUpload: true,
  };

  constructor(private readonly apiKey: string) {}

  private toSession(data: Record<string, unknown>, token?: ReplayToken): Session {
    const rawStatus = (data["status"] as string | undefined) ?? "active";
    const status: SessionStatus = STATUS_MAP[rawStatus] ?? "in_progress";
    const artifacts: Artifact[] = [];
    for (const item of (data["artifacts"] as Array<Record<string, unknown>> | undefined) ?? []) {
      if ((item["type"] as string | undefined) === "pull_request") {
        artifacts.push({
          kind: "pull_request",
          provider: "claude",
          url: item["url"] as string | undefined,
          title: item["title"] as string | undefined,
        });
      }
    }
    const sessionId = (data["id"] as string | undefined) ?? "";
    const agentId = (data["agent_id"] as string | undefined) ?? "";
    const envId = (data["environment_id"] as string | undefined) ?? "";
    const effectiveToken =
      token ?? RT._encode({ session_id: sessionId, agent_id: agentId, env_id: envId });
    return {
      id: sessionId,
      provider: "claude",
      status,
      createdAt: new Date((data["created_at"] as string | undefined) ?? Date.now()).toISOString(),
      updatedAt: new Date((data["updated_at"] as string | undefined) ?? Date.now()).toISOString(),
      artifacts,
      replayToken: effectiveToken,
    };
  }

  async createSession(opts: SessionOptions): Promise<Session> {
    const po = opts.providerOptions ?? {};
    const agentId = (po["agent_id"] as string | undefined) ?? "";
    const envId = (po["env_id"] as string | undefined) ?? "";
    const body: Record<string, unknown> = { agent_id: agentId, environment_id: envId };
    if (opts.prompt) body["initial_message"] = opts.prompt;
    if (opts.metadata) body["metadata"] = opts.metadata;
    const data = await req(this.apiKey, "POST", "/v1/sessions", body);
    const sid = (data["id"] as string | undefined) ?? "";
    const token = RT._encode({ session_id: sid, agent_id: agentId, env_id: envId });
    return this.toSession(data, token);
  }

  async getSession(sessionId: string, replayToken?: ReplayToken): Promise<Session> {
    const data = await req(this.apiKey, "GET", `/v1/sessions/${sessionId}`);
    let agentId = "";
    let envId = "";
    if (replayToken) {
      const decoded = replayToken._decode();
      agentId = (decoded["agent_id"] as string | undefined) ?? "";
      envId = (decoded["env_id"] as string | undefined) ?? "";
    }
    const token = RT._encode({ session_id: sessionId, agent_id: agentId, env_id: envId });
    return this.toSession(data, token);
  }

  async *streamEvents(
    sessionId: string,
    replayToken?: ReplayToken,
    sinceSeq = 0,
  ): AsyncIterableIterator<Event> {
    let sinceProcessedAt: string | undefined;
    if (replayToken) {
      const decoded = replayToken._decode();
      sinceProcessedAt = decoded["last_processed_at"] as string | undefined;
    }

    let seq = sinceSeq;
    let pendingToolUse: Record<string, unknown> | null = null;

    for await (const rawEv of claudeSseStream(
      BASE,
      this.apiKey,
      EXTRA_HEADERS,
      sessionId,
      sinceProcessedAt,
    )) {
      const evType = (rawEv["type"] as string | undefined) ?? "";
      const tsStr = (rawEv["created_at"] as string | undefined) ?? new Date().toISOString();
      const ts = new Date(tsStr).toISOString();

      if (evType === "agent.message") {
        let text = "";
        for (const block of (rawEv["content"] as Array<Record<string, unknown>> | undefined) ?? []) {
          if (block["type"] === "text") text += (block["text"] as string | undefined) ?? "";
        }
        yield { kind: "message", sessionId, provider: "claude", ts, seq: seq++, data: { text }, raw: rawEv };
      } else if (evType === "agent.tool_use") {
        pendingToolUse = rawEv;
      } else if (evType === "agent.tool_result") {
        if (pendingToolUse) {
          const toolName = (pendingToolUse["tool_name"] as string | undefined) ?? "";
          let summary = rawEv["content"] ?? "";
          if (Array.isArray(summary)) {
            summary = (summary as Array<Record<string, unknown>>)
              .map((b) => (b["text"] as string | undefined) ?? "")
              .join(" ");
          }
          yield {
            kind: "tool_activity",
            sessionId,
            provider: "claude",
            ts,
            seq: seq++,
            data: { tool: toolName, summary: String(summary) },
            raw: { tool_use: pendingToolUse, tool_result: rawEv },
          };
          pendingToolUse = null;
        } else {
          yield { kind: "provider_event", sessionId, provider: "claude", ts, seq: seq++, data: { type: evType, raw: rawEv }, raw: rawEv };
        }
      } else if (evType === "agent.mcp_tool_use" || evType === "agent.custom_tool_use") {
        pendingToolUse = rawEv;
      } else if (evType === "agent.mcp_tool_result" || evType === "agent.custom_tool_result") {
        if (pendingToolUse) {
          const toolName = (pendingToolUse["tool_name"] as string | undefined) ?? "";
          const extra = evType === "agent.mcp_tool_result" ? { mcp: true } : { custom: true };
          yield {
            kind: "tool_activity",
            sessionId,
            provider: "claude",
            ts,
            seq: seq++,
            data: { tool: toolName, summary: String(rawEv["content"] ?? ""), ...extra },
            raw: { tool_use: pendingToolUse, tool_result: rawEv },
          };
          pendingToolUse = null;
        }
      } else if (evType === "agent.thinking") {
        yield { kind: "provider_event", sessionId, provider: "claude", ts, seq: seq++, data: { type: "thinking", text: (rawEv["thinking"] as string | undefined) ?? "" }, raw: rawEv };
      } else if (evType === "session.status_idle") {
        if ((rawEv["end_reason"] as string | undefined) === "end_turn") {
          if (pendingToolUse) {
            yield { kind: "provider_event", sessionId, provider: "claude", ts, seq: seq++, data: { type: "agent.tool_use", raw: pendingToolUse }, raw: pendingToolUse };
            pendingToolUse = null;
          }
          yield { kind: "status", sessionId, provider: "claude", ts, seq: seq++, data: { value: "completed" }, raw: rawEv };
          return;
        } else {
          const action = rawEv["requires_action"] as Record<string, unknown> | undefined;
          yield { kind: "requires_input", sessionId, provider: "claude", ts, seq: seq++, data: { question: action?.["description"] }, raw: rawEv };
        }
      } else if (evType === "session.error") {
        yield { kind: "status", sessionId, provider: "claude", ts, seq: seq++, data: { value: "failed", error: rawEv["error"] }, raw: rawEv };
        return;
      } else {
        yield { kind: "provider_event", sessionId, provider: "claude", ts, seq: seq++, data: { type: evType, raw: rawEv }, raw: rawEv };
      }
    }
  }

  async cancelSession(sessionId: string, _replayToken?: ReplayToken): Promise<void> {
    try {
      await req(this.apiKey, "POST", `/v1/sessions/${sessionId}/events`, { type: "user.interrupt" });
    } catch { /* best effort */ }
    await req(this.apiKey, "DELETE", `/v1/sessions/${sessionId}`);
  }

  async sendMessage(sessionId: string, message: string, _replayToken?: ReplayToken): Promise<void> {
    await req(this.apiKey, "POST", `/v1/sessions/${sessionId}/events`, {
      type: "user.message",
      content: [{ type: "text", text: message }],
    });
  }

  async listSessions(limit = 20, cursor?: string): Promise<SessionPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("after_id", cursor);
    const data = await req(this.apiKey, "GET", `/v1/sessions?${params}`);
    const sessions = ((data["sessions"] as Array<Record<string, unknown>> | undefined) ?? []).map(
      (s) => this.toSession(s),
    );
    return { sessions, nextCursor: data["last_id"] as string | undefined, provider: "claude" };
  }

  async sendToolResult(
    sessionId: string,
    toolUseId: string,
    result: unknown,
    replayToken?: ReplayToken,
  ): Promise<void> {
    const sid = replayToken
      ? ((replayToken._decode()["session_id"] as string | undefined) ?? sessionId)
      : sessionId;
    await req(this.apiKey, "POST", `/v1/sessions/${sid}/events`, {
      type: "user.tool_result",
      tool_use_id: toolUseId,
      content: result,
    });
  }

  async uploadFile(content: Uint8Array, name: string, mimeType = "application/octet-stream"): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: mimeType }), name);
    const resp = await fetch(`${BASE}/v1/files`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, ...EXTRA_HEADERS },
      body: form,
    });
    const data = (await resp.json()) as Record<string, unknown>;
    if (!resp.ok) {
      const hdrs: Record<string, string> = {};
      resp.headers.forEach((v, k) => { hdrs[k] = v; });
      throw classifyHttpError(resp.status, data, "claude", hdrs);
    }
    return (data["id"] as string | undefined) ?? "";
  }
}
