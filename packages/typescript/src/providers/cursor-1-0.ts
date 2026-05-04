import { OmniHarnessError, UnsupportedCapability } from "../errors.js";
import type {
  Event,
  ProviderId,
  ProviderCapabilities,
  ReplayToken,
  Session,
  SessionOptions,
  SessionPage,
  Source,
} from "../types.js";
import { ReplayToken as RT } from "../types.js";

type CursorRuntime = "cloud" | "local" | "self_hosted";

interface CursorSdk {
  Agent: {
    create(opts: Record<string, unknown>): Promise<CursorSession>;
    getRun(
      runId: string,
      opts: { runtime: CursorRuntime; agentId: string },
    ): Promise<CursorSession>;
  };
}

interface CursorSession {
  agentId: string;
  id: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  branches?: Array<{ prUrl?: string }>;
  [Symbol.asyncIterator](): AsyncIterator<CursorEvent>;
}

interface CursorEvent {
  type: string;
  text?: string;
  tool?: string;
  result?: string;
  [key: string]: unknown;
}

export class CursorProvider {
  readonly id: ProviderId = "cursor";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    cancellation: true,
    listSessions: false,
    sendMessage: false,
    planApproval: false,
    toolResults: false,
    fileUpload: false,
  };

  constructor(private readonly apiKey: string) {}

  private async sdk(): Promise<CursorSdk> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return (await import("@cursor/sdk")) as unknown as CursorSdk;
    } catch {
      throw new OmniHarnessError(
        "Could not load @cursor/sdk. Install it with: npm install @cursor/sdk",
      );
    }
  }

  private sourceToRepos(source?: Source): Array<{ repo: string }> {
    if (!source || source.kind === "none" || source.kind === "local") return [];
    const rest = source.uri.split("://")[1]?.split("@")[0] ?? "";
    return [{ repo: rest }];
  }

  private toSession(s: CursorSession, token: ReplayToken): Session {
    const statusMap: Record<string, string> = {
      running: "in_progress",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
      queued: "queued",
    };
    const artifacts = (s.branches ?? [])
      .filter((b) => b.prUrl)
      .map((b) => ({
        kind: "pull_request" as const,
        provider: "cursor" as const,
        url: b.prUrl,
      }));
    return {
      id: s.id,
      provider: "cursor",
      status: (statusMap[s.status] ?? "in_progress") as Session["status"],
      createdAt: s.createdAt ?? new Date().toISOString(),
      updatedAt: s.updatedAt ?? new Date().toISOString(),
      artifacts,
      replayToken: token,
    };
  }

  async createSession(opts: SessionOptions): Promise<Session> {
    const { Agent } = await this.sdk();
    const po = opts.providerOptions ?? {};
    const runtime: CursorRuntime =
      (po["runtime"] as CursorRuntime | undefined) ?? (opts.source ? "cloud" : "local");
    const agentOpts: Record<string, unknown> = {
      apiKey: this.apiKey,
      model: { id: (po["modelId"] as string | undefined) ?? "composer-2" },
    };
    if (runtime === "cloud") {
      agentOpts["cloud"] = {
        repos: this.sourceToRepos(opts.source),
        autoCreatePR: (po["autoCreatePR"] as boolean | undefined) ?? false,
      };
    } else {
      agentOpts["local"] = {
        cwd: (po["cwd"] as string | undefined) ?? process.cwd(),
      };
    }
    if (po["mcpServers"]) agentOpts["mcpServers"] = po["mcpServers"];

    const agent = await Agent.create(agentOpts);
    // @ts-expect-error — Cursor SDK .send() typing may vary
    const cursorSession = (await agent.send(opts.prompt)) as CursorSession;
    const token = RT._encode({ agent_id: cursorSession.agentId, runtime });
    return this.toSession(cursorSession, token);
  }

  async getSession(sessionId: string, replayToken?: ReplayToken): Promise<Session> {
    if (!replayToken) {
      throw new OmniHarnessError(
        "Cursor requires replayToken for getSession. " +
          "Store session.replayToken after createSession.",
      );
    }
    const { Agent } = await this.sdk();
    const decoded = replayToken._decode();
    const agentId = (decoded["agent_id"] as string | undefined) ?? "";
    const runtime = ((decoded["runtime"] as string | undefined) ?? "cloud") as CursorRuntime;
    const s = await Agent.getRun(sessionId, { runtime, agentId });
    return this.toSession(s, replayToken);
  }

  async *streamEvents(
    sessionId: string,
    replayToken?: ReplayToken,
    sinceSeq = 0,
  ): AsyncIterableIterator<Event> {
    if (!replayToken) {
      throw new OmniHarnessError(
        "Cursor requires replayToken for streamEvents. " +
          "Store session.replayToken after createSession.",
      );
    }
    const { Agent } = await this.sdk();
    const decoded = replayToken._decode();
    const agentId = (decoded["agent_id"] as string | undefined) ?? "";
    const runtime = ((decoded["runtime"] as string | undefined) ?? "cloud") as CursorRuntime;
    const cursorSession = await Agent.getRun(sessionId, { runtime, agentId });

    let seq = sinceSeq;
    let pendingTool: CursorEvent | null = null;

    for await (const ev of cursorSession) {
      const ts = new Date().toISOString();
      if (ev.type === "text") {
        yield {
          kind: "message",
          sessionId,
          provider: "cursor",
          ts,
          seq: seq++,
          data: { text: ev.text ?? "" },
          raw: ev,
        };
      } else if (ev.type === "tool_use") {
        pendingTool = ev;
      } else if (ev.type === "tool_result" && pendingTool) {
        yield {
          kind: "tool_activity",
          sessionId,
          provider: "cursor",
          ts,
          seq: seq++,
          data: { tool: pendingTool.tool ?? "", summary: ev.result ?? "" },
          raw: { tool_use: pendingTool, tool_result: ev },
        };
        pendingTool = null;
      } else if (ev.type === "done") {
        yield {
          kind: "status",
          sessionId,
          provider: "cursor",
          ts,
          seq: seq++,
          data: { value: "completed" },
          raw: ev,
        };
        return;
      } else if (ev.type === "error") {
        yield {
          kind: "status",
          sessionId,
          provider: "cursor",
          ts,
          seq: seq++,
          data: { value: "failed", error: ev },
          raw: ev,
        };
        return;
      } else {
        yield {
          kind: "provider_event",
          sessionId,
          provider: "cursor",
          ts,
          seq: seq++,
          data: { type: ev.type, raw: ev },
          raw: ev,
        };
      }
    }
  }

  async cancelSession(sessionId: string, replayToken?: ReplayToken): Promise<void> {
    if (!replayToken) return;
    const { Agent } = await this.sdk();
    const decoded = replayToken._decode();
    const agentId = (decoded["agent_id"] as string | undefined) ?? "";
    const runtime = ((decoded["runtime"] as string | undefined) ?? "cloud") as CursorRuntime;
    const s = await Agent.getRun(sessionId, { runtime, agentId });
    // @ts-expect-error — cancel() may not be typed
    if (typeof s.cancel === "function") await s.cancel();
  }

  async sendMessage(_sessionId: string, _message: string, _replayToken?: ReplayToken): Promise<void> {
    throw new UnsupportedCapability("cursor", "sendMessage");
  }

  async listSessions(_limit?: number, _cursor?: string): Promise<SessionPage> {
    throw new UnsupportedCapability("cursor", "listSessions");
  }
}
