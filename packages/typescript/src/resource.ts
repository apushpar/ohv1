import { SessionHandle } from "./handle.js";
import type { ProviderId, ReplayToken, SessionOptions, SessionPage } from "./types.js";
import { ReplayToken as RT } from "./types.js";
import type { OmniHarness } from "./client.js";

export class SessionsResource {
  constructor(private readonly client: OmniHarness) {}

  async create(provider: ProviderId, options: SessionOptions): Promise<SessionHandle> {
    const p = this.client._getProvider(provider, options.providerApiVersion);
    const session = await p.createSession(options);
    return new SessionHandle(session, p);
  }

  async get(
    provider: ProviderId,
    sessionId: string,
    replayToken?: ReplayToken | string,
    providerApiVersion?: string,
  ): Promise<SessionHandle> {
    const p = this.client._getProvider(provider, providerApiVersion);
    const token =
      typeof replayToken === "string" ? RT.fromString(replayToken) : replayToken;
    const session = await p.getSession(sessionId, token);
    return new SessionHandle(session, p);
  }

  async list(
    provider: ProviderId,
    limit = 20,
    cursor?: string,
    providerApiVersion?: string,
  ): Promise<SessionPage> {
    const p = this.client._getProvider(provider, providerApiVersion);
    return p.listSessions(limit, cursor);
  }
}
