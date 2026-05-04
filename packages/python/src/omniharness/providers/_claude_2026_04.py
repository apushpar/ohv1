from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

import httpx

from .._streaming import claude_sse_stream
from ..errors import classify_http_error
from ..types import (
    Artifact,
    Event,
    ProviderId,
    ProviderCapabilities,
    ReplayToken,
    Session,
    SessionOptions,
    SessionPage,
    SessionStatus,
)

_BASE = "https://api.anthropic.com"
_BETA = "managed-agents-2026-04-01"
_VERSION = "2023-06-01"

_STATUS_MAP: dict[str, SessionStatus] = {
    "active": "in_progress",
    "idle": "completed",
    "error": "failed",
    "cancelled": "cancelled",
}


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class Claude202604Provider:
    id: ProviderId = "claude"
    capabilities = ProviderCapabilities(
        streaming=True,
        cancellation=True,
        list_sessions=True,
        send_message=True,
        plan_approval=False,
        tool_results=True,
        file_upload=True,
    )

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key
        self._http = httpx.AsyncClient(
            base_url=_BASE,
            headers={
                "x-api-key": api_key,
                "anthropic-version": _VERSION,
                "anthropic-beta": _BETA,
            },
            timeout=60.0,
        )

    async def _req(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = await self._http.request(method, path, **kwargs)
        if resp.status_code >= 400:
            raise classify_http_error(
                resp.status_code, resp.json() if resp.content else {}, "claude", dict(resp.headers)
            )
        return resp

    def _to_session(self, data: dict[str, Any], token: Optional[ReplayToken] = None) -> Session:
        po = data.get("provider_options", {})
        status_raw = data.get("status", "active")
        status: SessionStatus = _STATUS_MAP.get(status_raw, "in_progress")
        artifacts: list[Artifact] = []
        for item in data.get("artifacts", []):
            if item.get("type") == "pull_request":
                artifacts.append(
                    Artifact(
                        kind="pull_request",
                        provider="claude",
                        url=item.get("url"),
                        title=item.get("title"),
                    )
                )
        session_id = data.get("id", "")
        agent_id = data.get("agent_id", "")
        env_id = data.get("environment_id", "")
        effective_token = token or ReplayToken._encode(
            {"session_id": session_id, "agent_id": agent_id, "env_id": env_id}
        )
        return Session(
            id=session_id,
            provider="claude",
            status=status,
            created_at=_parse_dt(data.get("created_at", datetime.now(timezone.utc).isoformat())),
            updated_at=_parse_dt(data.get("updated_at", datetime.now(timezone.utc).isoformat())),
            artifacts=artifacts,
            replay_token=effective_token,
        )

    async def create_session(self, opts: SessionOptions) -> Session:
        po = opts.provider_options or {}
        agent_id = po.get("agent_id", "")
        env_id = po.get("env_id", "")
        body: dict[str, Any] = {
            "agent_id": agent_id,
            "environment_id": env_id,
        }
        if opts.prompt:
            body["initial_message"] = opts.prompt
        if opts.metadata:
            body["metadata"] = opts.metadata
        resp = await self._req("POST", "/v1/sessions", json=body)
        data = resp.json()
        sid = data.get("id", "")
        token = ReplayToken._encode({"session_id": sid, "agent_id": agent_id, "env_id": env_id})
        return self._to_session(data, token)

    async def get_session(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> Session:
        resp = await self._req("GET", f"/v1/sessions/{session_id}")
        data = resp.json()
        agent_id = ""
        env_id = ""
        if replay_token:
            decoded = replay_token._decode()
            agent_id = decoded.get("agent_id", "")
            env_id = decoded.get("env_id", "")
        token = ReplayToken._encode(
            {"session_id": session_id, "agent_id": agent_id, "env_id": env_id}
        )
        return self._to_session(data, token)

    async def stream_events(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
        since_seq: int = 0,
    ) -> AsyncIterator[Event]:
        since_processed_at: Optional[str] = None
        if replay_token:
            decoded = replay_token._decode()
            since_processed_at = decoded.get("last_processed_at")

        seq = since_seq
        # Buffer for tool_use → tool_result collapse
        pending_tool_use: Optional[dict[str, Any]] = None

        async for raw_ev in claude_sse_stream(self._http, session_id, since_processed_at):
            ev_type = raw_ev.get("type", "")
            ts_str = raw_ev.get("created_at", datetime.now(timezone.utc).isoformat())
            try:
                ts = _parse_dt(ts_str)
            except ValueError:
                ts = datetime.now(timezone.utc)

            if ev_type == "agent.message":
                text = ""
                for block in raw_ev.get("content", []):
                    if block.get("type") == "text":
                        text += block.get("text", "")
                yield Event(
                    kind="message",
                    session_id=session_id,
                    provider="claude",
                    ts=ts,
                    seq=seq,
                    data={"text": text},
                    raw=raw_ev,
                )
                seq += 1

            elif ev_type == "agent.tool_use":
                # Buffer and wait for tool_result
                pending_tool_use = raw_ev

            elif ev_type == "agent.tool_result":
                if pending_tool_use:
                    tool_name = pending_tool_use.get("tool_name", "")
                    result_content = raw_ev.get("content", "")
                    if isinstance(result_content, list):
                        result_content = " ".join(
                            b.get("text", "") for b in result_content if isinstance(b, dict)
                        )
                    yield Event(
                        kind="tool_activity",
                        session_id=session_id,
                        provider="claude",
                        ts=ts,
                        seq=seq,
                        data={"tool": tool_name, "summary": str(result_content)},
                        raw={"tool_use": pending_tool_use, "tool_result": raw_ev},
                    )
                    seq += 1
                    pending_tool_use = None
                else:
                    yield Event(
                        kind="provider_event",
                        session_id=session_id,
                        provider="claude",
                        ts=ts,
                        seq=seq,
                        data={"type": ev_type, "raw": raw_ev},
                        raw=raw_ev,
                    )
                    seq += 1

            elif ev_type in ("agent.mcp_tool_use", "agent.custom_tool_use"):
                # Buffer for collapse
                pending_tool_use = raw_ev

            elif ev_type in ("agent.mcp_tool_result", "agent.custom_tool_result"):
                if pending_tool_use:
                    tool_name = pending_tool_use.get("tool_name", "")
                    result_content = raw_ev.get("content", "")
                    extra = {}
                    if ev_type == "agent.mcp_tool_result":
                        extra["mcp"] = True
                    else:
                        extra["custom"] = True
                    yield Event(
                        kind="tool_activity",
                        session_id=session_id,
                        provider="claude",
                        ts=ts,
                        seq=seq,
                        data={"tool": tool_name, "summary": str(result_content), **extra},
                        raw={"tool_use": pending_tool_use, "tool_result": raw_ev},
                    )
                    seq += 1
                    pending_tool_use = None

            elif ev_type == "agent.thinking":
                yield Event(
                    kind="provider_event",
                    session_id=session_id,
                    provider="claude",
                    ts=ts,
                    seq=seq,
                    data={"type": "thinking", "text": raw_ev.get("thinking", "")},
                    raw=raw_ev,
                )
                seq += 1

            elif ev_type == "session.status_idle":
                end_reason = raw_ev.get("end_reason", "")
                if end_reason == "end_turn":
                    # Flush any pending tool_use as provider_event
                    if pending_tool_use:
                        yield Event(
                            kind="provider_event",
                            session_id=session_id,
                            provider="claude",
                            ts=ts,
                            seq=seq,
                            data={"type": "agent.tool_use", "raw": pending_tool_use},
                            raw=pending_tool_use,
                        )
                        seq += 1
                        pending_tool_use = None
                    yield Event(
                        kind="status",
                        session_id=session_id,
                        provider="claude",
                        ts=ts,
                        seq=seq,
                        data={"value": "completed"},
                        raw=raw_ev,
                    )
                    return
                else:
                    yield Event(
                        kind="requires_input",
                        session_id=session_id,
                        provider="claude",
                        ts=ts,
                        seq=seq,
                        data={"question": raw_ev.get("requires_action", {}).get("description")},
                        raw=raw_ev,
                    )
                    seq += 1

            elif ev_type == "session.error":
                yield Event(
                    kind="status",
                    session_id=session_id,
                    provider="claude",
                    ts=ts,
                    seq=seq,
                    data={"value": "failed", "error": raw_ev.get("error", {})},
                    raw=raw_ev,
                )
                return

            else:
                yield Event(
                    kind="provider_event",
                    session_id=session_id,
                    provider="claude",
                    ts=ts,
                    seq=seq,
                    data={"type": ev_type, "raw": raw_ev},
                    raw=raw_ev,
                )
                seq += 1

    async def cancel_session(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None:
        try:
            await self._req(
                "POST",
                f"/v1/sessions/{session_id}/events",
                json={"type": "user.interrupt"},
            )
        except Exception:
            pass
        await self._req("DELETE", f"/v1/sessions/{session_id}")

    async def send_message(
        self,
        session_id: str,
        message: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None:
        await self._req(
            "POST",
            f"/v1/sessions/{session_id}/events",
            json={
                "type": "user.message",
                "content": [{"type": "text", "text": message}],
            },
        )

    async def list_sessions(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
    ) -> SessionPage:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["after_id"] = cursor
        resp = await self._req("GET", "/v1/sessions", params=params)
        data = resp.json()
        sessions = [self._to_session(s) for s in data.get("sessions", [])]
        return SessionPage(
            sessions=sessions,
            next_cursor=data.get("last_id"),
            provider="claude",
        )

    # Extension: SupportsToolResults
    async def send_tool_result(
        self,
        session_id: str,
        tool_use_id: str,
        result: Any,
        replay_token: Optional[ReplayToken] = None,
    ) -> None:
        sid = session_id
        if replay_token:
            decoded = replay_token._decode()
            sid = decoded.get("session_id", session_id)
        await self._req(
            "POST",
            f"/v1/sessions/{sid}/events",
            json={
                "type": "user.tool_result",
                "tool_use_id": tool_use_id,
                "content": result,
            },
        )

    # Extension: SupportsFileUpload
    async def upload_file(
        self,
        content: bytes,
        name: str,
        mime_type: str = "application/octet-stream",
    ) -> str:
        resp = await self._http.post(
            "/v1/files",
            files={"file": (name, content, mime_type)},
        )
        if resp.status_code >= 400:
            raise classify_http_error(
                resp.status_code, resp.json() if resp.content else {}, "claude", dict(resp.headers)
            )
        return resp.json().get("id", "")
