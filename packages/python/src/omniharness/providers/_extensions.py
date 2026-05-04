from __future__ import annotations

from typing import Any, Optional, Protocol

from ..types import ReplayToken


class SupportsPlanApproval(Protocol):
    """Jules only in v1."""

    async def approve_plan(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None: ...


class SupportsToolResults(Protocol):
    """Claude MA only in v1."""

    async def send_tool_result(
        self,
        session_id: str,
        tool_use_id: str,
        result: Any,
        replay_token: Optional[ReplayToken] = None,
    ) -> None: ...


class SupportsFileUpload(Protocol):
    """Claude MA only in v1."""

    async def upload_file(
        self,
        content: bytes,
        name: str,
        mime_type: str = "application/octet-stream",
    ) -> str: ...
