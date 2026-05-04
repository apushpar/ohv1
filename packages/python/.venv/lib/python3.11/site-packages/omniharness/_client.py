from __future__ import annotations

import os
import warnings
from typing import Optional

from .errors import AdapterDeprecatedError
from .types import ProviderCapabilities, ProviderId, SessionOptions

_CAPABILITIES: dict[str, ProviderCapabilities] = {
    "jules": ProviderCapabilities(
        streaming=False,
        cancellation=True,
        list_sessions=True,
        send_message=True,
        plan_approval=True,
        tool_results=False,
        file_upload=False,
    ),
    "claude": ProviderCapabilities(
        streaming=True,
        cancellation=True,
        list_sessions=True,
        send_message=True,
        plan_approval=False,
        tool_results=True,
        file_upload=True,
    ),
    "openhands": ProviderCapabilities(
        streaming=False,
        cancellation=False,
        list_sessions=True,
        send_message=False,
        plan_approval=False,
        tool_results=False,
        file_upload=False,
    ),
    "cursor": ProviderCapabilities(
        streaming=True,
        cancellation=True,
        list_sessions=False,
        send_message=False,
        plan_approval=False,
        tool_results=False,
        file_upload=False,
    ),
    "devin": ProviderCapabilities(
        streaming=False,
        cancellation=True,
        list_sessions=True,
        send_message=True,
        plan_approval=False,
        tool_results=False,
        file_upload=False,
    ),
}

_DEFAULTS: dict[str, str] = {
    "jules": "v1alpha",
    "claude": "2026-04",
    "openhands": "v1",
    "cursor": "1.0",
    "devin": "v3",
}

_DEPRECATED: set[tuple[str, str]] = set()


def _adapters() -> dict[str, dict[str, type]]:
    from .providers._claude_2026_04 import Claude202604Provider
    from .providers._cursor import CursorProvider
    from .providers._devin_v3 import DevinV3Provider
    from .providers._jules_v1alpha import JulesV1AlphaProvider
    from .providers._openhands_v1 import OpenHandsV1Provider

    return {
        "jules": {"v1alpha": JulesV1AlphaProvider},
        "claude": {"2026-04": Claude202604Provider},
        "openhands": {"v1": OpenHandsV1Provider},
        "cursor": {"1.0": CursorProvider},
        "devin": {"v3": DevinV3Provider},
    }


class OmniHarness:
    def __init__(
        self,
        *,
        provider_keys: dict[str, str] | None = None,
    ) -> None:
        self._keys = provider_keys or {}
        self._cache: dict[tuple[str, str], object] = {}
        from ._resource import SessionsResource

        self.sessions = SessionsResource(self)

    def _get_provider(self, provider_id: str, version: Optional[str] = None) -> object:
        v = self._resolve(provider_id, version)
        key = (provider_id, v)
        if key not in self._cache:
            self._cache[key] = self._build(provider_id, v)
        return self._cache[key]

    def _resolve(self, provider: str, requested: Optional[str]) -> str:
        version = requested or _DEFAULTS[provider]
        if (provider, version) in _DEPRECATED:
            warnings.warn(
                f"omniharness: {provider!r} adapter {version!r} is deprecated. "
                f"Migrate to provider_api_version={_DEFAULTS[provider]!r}.",
                DeprecationWarning,
                stacklevel=5,
            )
        registry = _adapters()
        if version not in registry.get(provider, {}):
            raise AdapterDeprecatedError(provider, version, _DEFAULTS[provider])
        return version

    def _build(self, provider_id: str, version: str) -> object:
        k = self._keys
        registry = _adapters()
        cls = registry[provider_id][version]
        builders: dict[str, object] = {
            "jules": lambda: cls(api_key=k.get("jules") or os.environ.get("JULES_API_KEY", "")),
            "claude": lambda: cls(
                api_key=k.get("claude") or os.environ.get("ANTHROPIC_API_KEY", "")
            ),
            "openhands": lambda: cls(
                api_key=k.get("openhands") or os.environ.get("OPENHANDS_API_KEY", "")
            ),
            "cursor": lambda: cls(
                api_key=k.get("cursor") or os.environ.get("CURSOR_API_KEY", "")
            ),
            "devin": lambda: cls(
                api_key=k.get("devin") or os.environ.get("DEVIN_API_KEY", ""),
                org_id=k.get("devin_org_id") or os.environ.get("DEVIN_ORG_ID", ""),
            ),
        }
        return builders[provider_id]()  # type: ignore[operator]

    def capabilities(self, provider: ProviderId) -> ProviderCapabilities:
        return _CAPABILITIES[provider]

    def run_sync(self, provider: ProviderId, options: SessionOptions) -> "SessionHandle":
        import asyncio

        from ._handle import SessionHandle

        return asyncio.run(self.sessions.create(provider, options))
