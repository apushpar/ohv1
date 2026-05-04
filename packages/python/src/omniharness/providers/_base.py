from __future__ import annotations

from typing import AsyncIterator, Optional, Protocol, runtime_checkable

from ..types import (
    Event,
    ProviderId,
    ProviderCapabilities,
    ReplayToken,
    Session,
    SessionOptions,
    SessionPage,
)


@runtime_checkable
class BaseProvider(Protocol):
    id: ProviderId
    capabilities: ProviderCapabilities

    async def create_session(self, opts: SessionOptions) -> Session: ...

    async def get_session(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> Session: ...

    async def stream_events(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
        since_seq: int = 0,
    ) -> AsyncIterator[Event]: ...

    async def cancel_session(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None: ...

    async def send_message(
        self,
        session_id: str,
        message: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None: ...

    async def list_sessions(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
    ) -> SessionPage: ...
