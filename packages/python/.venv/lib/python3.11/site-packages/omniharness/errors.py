from __future__ import annotations

from typing import Optional


class OmniHarnessError(Exception):
    pass


class ProviderError(OmniHarnessError):
    def __init__(
        self,
        kind: str,
        message: str,
        provider: str,
        retryable: bool,
        retry_after: Optional[float] = None,
        http_status: Optional[int] = None,
    ):
        super().__init__(message)
        self.kind = kind
        self.provider = provider
        self.retryable = retryable
        self.retry_after = retry_after
        self.http_status = http_status


class UnsupportedCapability(OmniHarnessError):
    def __init__(self, provider: str, feature: str):
        super().__init__(
            f"{provider!r} does not support {feature!r}. "
            f"Check client.capabilities('{provider}').{feature}."
        )
        self.provider = provider
        self.feature = feature


class ProviderLanguageError(OmniHarnessError):
    def __init__(self, provider: str, required_language: str, install_hint: str):
        super().__init__(
            f"{provider!r} requires the {required_language} SDK. {install_hint}"
        )
        self.provider = provider
        self.required_language = required_language


class AdapterDeprecatedError(OmniHarnessError):
    def __init__(self, provider: str, version: str, replacement: str):
        super().__init__(
            f"The {provider!r} adapter version {version!r} has been removed. "
            f"Migrate to provider_api_version={replacement!r}. "
            f"See https://docs.omniharness.dev/migration"
        )
        self.provider = provider
        self.version = version
        self.replacement = replacement


def classify_http_error(
    status: int,
    body: dict,  # type: ignore[type-arg]
    provider: str,
    headers: dict,  # type: ignore[type-arg]
) -> ProviderError:
    retry_after: Optional[float] = None
    try:
        retry_after = float(headers.get("retry-after", ""))
    except (ValueError, TypeError):
        pass

    if status in (401, 403):
        return ProviderError("auth", str(body), provider, False, http_status=status)
    if status == 404:
        return ProviderError("not_found", str(body), provider, False, http_status=status)
    if status == 429:
        return ProviderError(
            "rate_limit", str(body), provider, True, retry_after=retry_after, http_status=status
        )
    if status in (400, 422):
        return ProviderError("invalid_request", str(body), provider, False, http_status=status)
    if status in (503, 529):
        return ProviderError("overloaded", str(body), provider, True, http_status=status)
    if status >= 500:
        return ProviderError("transient", str(body), provider, True, http_status=status)
    return ProviderError("provider_quirk", str(body), provider, False, http_status=status)
