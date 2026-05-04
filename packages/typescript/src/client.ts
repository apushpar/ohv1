import { AdapterDeprecatedError } from "./errors.js";
import type { BaseProvider } from "./providers/base.js";
import { Claude202604Provider } from "./providers/claude-2026-04.js";
import { CursorProvider } from "./providers/cursor-1-0.js";
import { DevinV3Provider } from "./providers/devin-v3.js";
import { JulesV1AlphaProvider } from "./providers/jules-v1alpha.js";
import { OpenHandsV1Provider } from "./providers/openhands-v1.js";
import { SessionsResource } from "./resource.js";
import type { ProviderId, ProviderCapabilities, SessionOptions } from "./types.js";
import { SessionHandle } from "./handle.js";

type AdapterRegistry = Record<string, Record<string, new (...args: never[]) => BaseProvider>>;

const ADAPTERS: AdapterRegistry = {
  jules: { "v1alpha": JulesV1AlphaProvider as never },
  claude: { "2026-04": Claude202604Provider as never },
  openhands: { "v1": OpenHandsV1Provider as never },
  cursor: { "1.0": CursorProvider as never },
  devin: { "v3": DevinV3Provider as never },
};

const DEFAULTS: Record<string, string> = {
  jules: "v1alpha",
  claude: "2026-04",
  openhands: "v1",
  cursor: "1.0",
  devin: "v3",
};

const DEPRECATED = new Set<string>();

const CAPABILITIES: Record<string, ProviderCapabilities> = {
  jules: {
    streaming: false,
    cancellation: true,
    listSessions: true,
    sendMessage: true,
    planApproval: true,
    toolResults: false,
    fileUpload: false,
  },
  claude: {
    streaming: true,
    cancellation: true,
    listSessions: true,
    sendMessage: true,
    planApproval: false,
    toolResults: true,
    fileUpload: true,
  },
  openhands: {
    streaming: false,
    cancellation: false,
    listSessions: true,
    sendMessage: false,
    planApproval: false,
    toolResults: false,
    fileUpload: false,
  },
  cursor: {
    streaming: true,
    cancellation: true,
    listSessions: false,
    sendMessage: false,
    planApproval: false,
    toolResults: false,
    fileUpload: false,
  },
  devin: {
    streaming: false,
    cancellation: true,
    listSessions: true,
    sendMessage: true,
    planApproval: false,
    toolResults: false,
    fileUpload: false,
  },
};

export class OmniHarness {
  readonly sessions: SessionsResource;
  private readonly cache = new Map<string, BaseProvider>();

  constructor(
    private readonly config: {
      providerKeys?: Partial<Record<ProviderId | "devin_org_id", string>>;
    } = {},
  ) {
    this.sessions = new SessionsResource(this);
  }

  _getProvider(providerId: ProviderId, version?: string): BaseProvider {
    const v = this._resolve(providerId, version);
    const cacheKey = `${providerId}:${v}`;
    let provider = this.cache.get(cacheKey);
    if (!provider) {
      provider = this._build(providerId, v);
      this.cache.set(cacheKey, provider);
    }
    return provider;
  }

  private _resolve(provider: string, requested?: string): string {
    const version = requested ?? DEFAULTS[provider] ?? "";
    const depKey = `${provider}:${version}`;
    if (DEPRECATED.has(depKey)) {
      console.warn(
        `omniharness: ${JSON.stringify(provider)} adapter ${JSON.stringify(version)} is deprecated. ` +
          `Migrate to providerApiVersion=${JSON.stringify(DEFAULTS[provider])}.`,
      );
    }
    const providerAdapters = ADAPTERS[provider];
    if (!providerAdapters || !(version in providerAdapters)) {
      throw new AdapterDeprecatedError(provider, version, DEFAULTS[provider] ?? "");
    }
    return version;
  }

  private _build(providerId: string, version: string): BaseProvider {
    const keys = this.config.providerKeys ?? {};
    const getEnv = (k: string) =>
      typeof process !== "undefined" ? (process.env[k] ?? "") : "";

    const AdapterClass = ADAPTERS[providerId]![version]!;

    switch (providerId) {
      case "jules":
        return new AdapterClass(
          keys["jules"] ?? getEnv("JULES_API_KEY"),
        ) as unknown as BaseProvider;
      case "claude":
        return new AdapterClass(
          keys["claude"] ?? getEnv("ANTHROPIC_API_KEY"),
        ) as unknown as BaseProvider;
      case "openhands":
        return new AdapterClass(
          keys["openhands"] ?? getEnv("OPENHANDS_API_KEY"),
        ) as unknown as BaseProvider;
      case "cursor":
        return new AdapterClass(
          keys["cursor"] ?? getEnv("CURSOR_API_KEY"),
        ) as unknown as BaseProvider;
      case "devin":
        return new (AdapterClass as unknown as new (apiKey: string, orgId: string) => BaseProvider)(
          keys["devin"] ?? getEnv("DEVIN_API_KEY"),
          keys["devin_org_id"] ?? getEnv("DEVIN_ORG_ID"),
        );
      default:
        throw new Error(`Unknown provider: ${providerId}`);
    }
  }

  capabilities(provider: ProviderId): ProviderCapabilities {
    return CAPABILITIES[provider]!;
  }
}
