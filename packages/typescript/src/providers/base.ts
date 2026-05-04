import type {
  Event,
  ProviderId,
  ProviderCapabilities,
  ReplayToken,
  Session,
  SessionOptions,
  SessionPage,
} from "../types.js";

export interface BaseProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  createSession(opts: SessionOptions): Promise<Session>;
  getSession(sessionId: string, replayToken?: ReplayToken): Promise<Session>;
  streamEvents(
    sessionId: string,
    replayToken?: ReplayToken,
    sinceSeq?: number,
  ): AsyncIterableIterator<Event>;
  cancelSession(sessionId: string, replayToken?: ReplayToken): Promise<void>;
  sendMessage(sessionId: string, message: string, replayToken?: ReplayToken): Promise<void>;
  listSessions(limit?: number, cursor?: string): Promise<SessionPage>;
}
