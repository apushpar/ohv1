from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .types import ProviderId, ReplayToken, SessionOptions, SessionPage

if TYPE_CHECKING:
    from ._client import OmniHarness
    from ._handle import SessionHandle


class SessionsResource:
    def __init__(self, client: "OmniHarness") -> None:
        self._client = client

    async def create(
        self,
        provider: ProviderId,
        options: SessionOptions,
    ) -> "SessionHandle":
        from ._handle import SessionHandle

        p = self._client._get_provider(provider, options.provider_api_version)
        session = await p.create_session(options)  # type: ignore[union-attr]
        return SessionHandle(session, p)

    async def get(
        self,
        provider: ProviderId,
        session_id: str,
        replay_token: "ReplayToken | str | None" = None,
        provider_api_version: Optional[str] = None,
    ) -> "SessionHandle":
        from ._handle import SessionHandle

        p = self._client._get_provider(provider, provider_api_version)
        token = (
            ReplayToken.from_string(str(replay_token))
            if isinstance(replay_token, str)
            else replay_token
        )
        session = await p.get_session(session_id, token)  # type: ignore[union-attr]
        return SessionHandle(session, p)

    async def list(
        self,
        provider: ProviderId,
        limit: int = 20,
        cursor: Optional[str] = None,
        provider_api_version: Optional[str] = None,
    ) -> SessionPage:
        p = self._client._get_provider(provider, provider_api_version)
        return await p.list_sessions(limit=limit, cursor=cursor)  # type: ignore[union-attr]
