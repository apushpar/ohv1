import { UnsupportedCapability } from "./errors.js";
import type { SupportsPlanApproval, SupportsToolResults } from "./providers/extensions.js";
import type {
  Artifact,
  Event,
  ProviderId,
  ReplayToken,
  Session,
  SessionStatus,
} from "./types.js";
import { getPullRequestUrl } from "./types.js";
import type { BaseProvider } from "./providers/base.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class SessionHandle {
  private _replayToken: ReplayToken | undefined;

  constructor(
    private _session: Session,
    private readonly _provider: BaseProvider,
  ) {
    this._replayToken = _session.replayToken;
  }

  get id(): string {
    return this._session.id;
  }

  get provider(): ProviderId {
    return this._session.provider;
  }

  get status(): SessionStatus {
    return this._session.status;
  }

  get artifacts(): Artifact[] {
    return this._session.artifacts;
  }

  get replayToken(): ReplayToken | undefined {
    return this._replayToken;
  }

  get pullRequestUrl(): string | undefined {
    return getPullRequestUrl(this._session);
  }

  async wait(timeoutMs?: number): Promise<SessionHandle> {
    const t0 = Date.now();
    for await (const event of this.stream()) {
      if (event.kind === "status" && TERMINAL.has(event.data["value"] as string)) break;
      if (timeoutMs && Date.now() - t0 >= timeoutMs) {
        throw new Error(`Session ${this.id} timed out after ${timeoutMs}ms`);
      }
    }
    return this.refresh();
  }

  async *stream(sinceSeq = 0): AsyncIterableIterator<Event> {
    yield* this._provider.streamEvents(this.id, this._replayToken, sinceSeq);
  }

  async cancel(): Promise<void> {
    await this._provider.cancelSession(this.id, this._replayToken);
  }

  async sendMessage(message: string): Promise<void> {
    await this._provider.sendMessage(this.id, message, this._replayToken);
  }

  async refresh(): Promise<SessionHandle> {
    const updated = await this._provider.getSession(this.id, this._replayToken);
    return new SessionHandle(updated, this._provider);
  }

  async approvePlan(): Promise<void> {
    if (!this._provider.capabilities.planApproval) {
      throw new UnsupportedCapability(this._provider.id, "approvePlan");
    }
    const p = this._provider as unknown as SupportsPlanApproval;
    if (typeof p.approvePlan !== "function") {
      throw new UnsupportedCapability(this._provider.id, "approvePlan");
    }
    await p.approvePlan(this.id, this._replayToken);
  }

  async sendToolResult(toolUseId: string, result: unknown): Promise<void> {
    if (!this._provider.capabilities.toolResults) {
      throw new UnsupportedCapability(this._provider.id, "sendToolResult");
    }
    const p = this._provider as unknown as SupportsToolResults;
    if (typeof p.sendToolResult !== "function") {
      throw new UnsupportedCapability(this._provider.id, "sendToolResult");
    }
    await p.sendToolResult(this.id, toolUseId, result, this._replayToken);
  }
}
