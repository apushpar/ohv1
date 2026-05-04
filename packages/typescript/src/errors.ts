export class OmniHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmniHarnessError";
  }
}

export class ProviderError extends OmniHarnessError {
  constructor(
    public readonly kind: string,
    message: string,
    public readonly provider: string,
    public readonly retryable: boolean,
    public readonly retryAfter?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class UnsupportedCapability extends OmniHarnessError {
  constructor(
    public readonly provider: string,
    public readonly feature: string,
  ) {
    super(
      `${JSON.stringify(provider)} does not support ${JSON.stringify(feature)}. ` +
        `Check client.capabilities('${provider}').${feature}.`,
    );
    this.name = "UnsupportedCapability";
  }
}

export class ProviderLanguageError extends OmniHarnessError {
  constructor(
    public readonly provider: string,
    public readonly requiredLanguage: string,
    installHint: string,
  ) {
    super(
      `${JSON.stringify(provider)} requires the ${requiredLanguage} SDK. ${installHint}`,
    );
    this.name = "ProviderLanguageError";
  }
}

export class AdapterDeprecatedError extends OmniHarnessError {
  constructor(
    public readonly provider: string,
    public readonly version: string,
    public readonly replacement: string,
  ) {
    super(
      `The ${JSON.stringify(provider)} adapter version ${JSON.stringify(version)} has been removed. ` +
        `Migrate to providerApiVersion=${JSON.stringify(replacement)}. ` +
        `See https://docs.omniharness.dev/migration`,
    );
    this.name = "AdapterDeprecatedError";
  }
}

export function classifyHttpError(
  status: number,
  body: Record<string, unknown>,
  provider: string,
  headers: Record<string, string>,
): ProviderError {
  let retryAfter: number | undefined;
  const ra = headers["retry-after"];
  if (ra !== undefined) {
    const parsed = parseFloat(ra);
    if (!isNaN(parsed)) retryAfter = parsed;
  }

  if (status === 401 || status === 403) {
    return new ProviderError("auth", JSON.stringify(body), provider, false, undefined, status);
  }
  if (status === 404) {
    return new ProviderError("not_found", JSON.stringify(body), provider, false, undefined, status);
  }
  if (status === 429) {
    return new ProviderError("rate_limit", JSON.stringify(body), provider, true, retryAfter, status);
  }
  if (status === 400 || status === 422) {
    return new ProviderError("invalid_request", JSON.stringify(body), provider, false, undefined, status);
  }
  if (status === 503 || status === 529) {
    return new ProviderError("overloaded", JSON.stringify(body), provider, true, undefined, status);
  }
  if (status >= 500) {
    return new ProviderError("transient", JSON.stringify(body), provider, true, undefined, status);
  }
  return new ProviderError("provider_quirk", JSON.stringify(body), provider, false, undefined, status);
}
