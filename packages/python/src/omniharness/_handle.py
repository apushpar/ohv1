from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, AsyncIterator, Optional

from .errors import UnsupportedCapability
from .providers._extensions import SupportsPlanApproval, SupportsToolResults
from .types import Artifact, Event, ProviderId, ReplayToken, Session, SessionStatus

TERMINAL = {"completed", "failed", "cancelled"}


class SessionHandle:
    def __init__(self, session: Session, provider: Any) -> None:
        self._session = session
        self._provider = provider
        self._replay_token = session.replay_token

    @property
    def id(self) -> str:
        return self._session.id

    @property
    def provider(self) -> ProviderId:
        return self._session.provider

    @property
    def status(self) -> SessionStatus:
        return self._session.status

    @property
    def artifacts(self) -> list[Artifact]:
        return self._session.artifacts

    @property
    def replay_token(self) -> Optional[ReplayToken]:
        return self._replay_token

    @property
    def pull_request_url(self) -> Optional[str]:
        return self._session.pull_request_url

    async def wait(self, timeout: Optional[float] = None) -> "SessionHandle":
        t0 = asyncio.get_event_loop().time()
        async for event in self.stream():
            if event.kind == "status" and event.data.get("value") in TERMINAL:
                break
            if timeout and asyncio.get_event_loop().time() - t0 >= timeout:
                raise TimeoutError(f"Session {self.id} timed out after {timeout}s")
        return await self.refresh()

    async def stream(self, since_seq: int = 0) -> AsyncIterator[Event]:
        async for event in self._provider.stream_events(
            self.id, self._replay_token, since_seq
        ):
            if hasattr(event, "_updated_token") and event._updated_token:
                self._replay_token = event._updated_token
            yield event

    async def cancel(self) -> None:
        await self._provider.cancel_session(self.id, self._replay_token)

    async def send_message(self, message: str) -> None:
        await self._provider.send_message(self.id, message, self._replay_token)

    async def refresh(self) -> "SessionHandle":
        updated = await self._provider.get_session(self.id, self._replay_token)
        return SessionHandle(updated, self._provider)

    async def approve_plan(self) -> None:
        if not self._provider.capabilities.plan_approval:
            raise UnsupportedCapability(self._provider.id, "approve_plan")
        if not isinstance(self._provider, SupportsPlanApproval):
            raise UnsupportedCapability(self._provider.id, "approve_plan")
        await self._provider.approve_plan(self.id, self._replay_token)

    async def send_tool_result(self, tool_use_id: str, result: Any) -> None:
        if not self._provider.capabilities.tool_results:
            raise UnsupportedCapability(self._provider.id, "send_tool_result")
        if not isinstance(self._provider, SupportsToolResults):
            raise UnsupportedCapability(self._provider.id, "send_tool_result")
        await self._provider.send_tool_result(
            self.id, tool_use_id, result, self._replay_token
        )
