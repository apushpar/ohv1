from __future__ import annotations

from ..errors import ProviderLanguageError
from ..types import ProviderCapabilities, ProviderId


class CursorProvider:
    """Cursor SDK is TypeScript-only. Install: npm install omniharness"""

    id: ProviderId = "cursor"
    capabilities = ProviderCapabilities(
        streaming=True,
        cancellation=True,
        list_sessions=False,
        send_message=False,
        plan_approval=False,
        tool_results=False,
        file_upload=False,
    )

    def __init__(self, *args: object, **kwargs: object) -> None:
        raise ProviderLanguageError(
            provider="cursor",
            required_language="typescript",
            install_hint="npm install omniharness",
        )
