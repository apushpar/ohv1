export type ProviderId = "jules" | "claude" | "openhands" | "cursor" | "devin";

export type SessionStatus =
  | "queued"
  | "in_progress"
  | "awaiting_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type EventKind =
  | "message"
  | "tool_activity"
  | "requires_input"
  | "artifact"
  | "status"
  | "provider_event";

export class ReplayToken {
  private constructor(private readonly encoded: string) {}

  static _encode(data: Record<string, unknown>): ReplayToken {
    return new ReplayToken(btoa(JSON.stringify(data)));
  }

  _decode(): Record<string, unknown> {
    return JSON.parse(atob(this.encoded)) as Record<string, unknown>;
  }

  toString(): string {
    return this.encoded;
  }

  static fromString(s: string): ReplayToken {
    return new ReplayToken(s);
  }
}

export interface Source {
  uri: string;
  kind?: "github" | "gitlab" | "bitbucket" | "local" | "none";
  branch?: string;
}

export function parseSource(uri: string): Source {
  if (uri === "none:") return { uri, kind: "none" };
  for (const scheme of ["github", "gitlab", "bitbucket"] as const) {
    if (uri.startsWith(`${scheme}://`)) {
      const rest = uri.slice(scheme.length + 3);
      const [repoPart, branch] = rest.split("@", 2) as [string, string | undefined];
      return { uri, kind: scheme, branch: branch ?? undefined };
    }
  }
  if (uri.startsWith("local://")) return { uri, kind: "local" };
  throw new Error(`Unrecognised source URI: ${JSON.stringify(uri)}`);
}

export interface SessionOptions {
  prompt: string;
  source?: Source;
  title?: string;
  timeoutSeconds?: number;
  idempotencyKey?: string;
  providerApiVersion?: string;
  metadata?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export interface Artifact {
  kind: "pull_request" | "branch" | "file" | "screenshot" | "commit";
  provider: ProviderId;
  url?: string;
  path?: string;
  title?: string;
  name?: string;
  sha?: string;
  data?: Record<string, unknown>;
}

export interface Event {
  kind: EventKind;
  sessionId: string;
  provider: ProviderId;
  ts: string;
  seq: number;
  data: Record<string, unknown>;
  raw?: unknown;
}

export interface Session {
  id: string;
  provider: ProviderId;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  artifacts: Artifact[];
  replayToken?: ReplayToken;
}

export function getPullRequestUrl(session: Session): string | undefined {
  for (const a of session.artifacts) {
    if (a.kind === "pull_request" && a.url) return a.url;
  }
  return undefined;
}

export interface SessionPage {
  sessions: Session[];
  nextCursor?: string;
  provider?: ProviderId;
}

export interface ProviderCapabilities {
  streaming: boolean;
  cancellation: boolean;
  listSessions: boolean;
  sendMessage: boolean;
  planApproval: boolean;
  toolResults: boolean;
  fileUpload: boolean;
}
