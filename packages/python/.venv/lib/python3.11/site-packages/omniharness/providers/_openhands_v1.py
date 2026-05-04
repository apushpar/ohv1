from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

import httpx

from .._streaming import polling_stream
from ..errors import UnsupportedCapability, classify_http_error
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

_BASE = "https://app.all-hands.dev"

_STATUS_MAP: dict[str, SessionStatus] = {
    "finished": "completed",
    "error": "failed",
    "stuck": "failed",
    "waiting_for_confirmation": "awaiting_input",
    "running": "in_progress",
    "starting": "in_progress",
    "ready": "in_progress",
}


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class OpenHandsV1Provider:
    id: ProviderId = "openhands"
    capabilities = ProviderCapabilities(
        streaming=False,
        cancellation=False,
        list_sessions=True,
        send_message=False,
        plan_approval=False,
        tool_results=False,
        file_upload=False,
    )

    def __init__(self, api_key: str) -> None:
        self._http = httpx.AsyncClient(
            base_url=_BASE,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30.0,
        )

    async def _req(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = await self._http.request(method, path, **kwargs)
        if resp.status_code >= 400:
            raise classify_http_error(
                resp.status_code,
                resp.json() if resp.content else {},
                "openhands",
                dict(resp.headers),
            )
        return resp

    def _to_session(self, data: dict[str, Any], token: Optional[ReplayToken] = None) -> Session:
        conv_id = data.get("conversation_id", data.get("id", ""))
        raw_status = data.get("status", "running")
        status: SessionStatus = _STATUS_MAP.get(raw_status, "in_progress")
        artifacts: list[Artifact] = []
        if pr_url := data.get("pull_request_url"):
            artifacts.append(
                Artifact(kind="pull_request", provider="openhands", url=pr_url)
            )
        effective_token = token or ReplayToken._encode(
            {"conversation_id": conv_id, "start_task_id": data.get("start_task_id", "")}
        )
        ts_str = data.get("created_at", datetime.now(timezone.utc).isoformat())
        return Session(
            id=conv_id,
            provider="openhands",
            status=status,
            created_at=_parse_dt(ts_str),
            updated_at=_parse_dt(data.get("updated_at", ts_str)),
            artifacts=artifacts,
            replay_token=effective_token,
        )

    async def _wait_for_ready(self, start_task_id: str) -> str:
        for _ in range(60):
            resp = await self._req(
                "GET",
                "/api/v1/app-conversations/start-tasks",
                params={"ids": start_task_id},
            )
            tasks = resp.json()
            task = tasks[0] if tasks else {}
            if task.get("status") == "READY":
                return task.get("conversation_id", "")
            await asyncio.sleep(2.0)
        raise TimeoutError("OpenHands conversation did not become ready in time")

    async def create_session(self, opts: SessionOptions) -> Session:
        po = opts.provider_options or {}
        body: dict[str, Any] = {
            "initial_message": {"role": "user", "content": opts.prompt},
        }
        if opts.source and opts.source.kind in ("github", "gitlab", "bitbucket"):
            repo_path = opts.source.uri.split("://", 1)[1].split("@", 1)[0]
            body["selected_repository"] = repo_path
        if mcp := po.get("mcp_servers"):
            body["mcp_servers"] = mcp
        if model := po.get("model_name"):
            body["model_name"] = model

        resp = await self._req("POST", "/api/v1/app-conversations", json=body)
        data = resp.json()
        start_task_id = data.get("start_task_id", "")
        conversation_id = await self._wait_for_ready(start_task_id)
        token = ReplayToken._encode(
            {"conversation_id": conversation_id, "start_task_id": start_task_id}
        )
        session_data = await self._fetch_conversation(conversation_id)
        session_data["start_task_id"] = start_task_id
        return self._to_session(session_data, token)

    async def _fetch_conversation(self, conversation_id: str) -> dict[str, Any]:
        resp = await self._req(
            "GET", "/api/v1/app-conversations", params={"ids": conversation_id}
        )
        convs = resp.json()
        return convs[0] if convs else {}

    async def get_session(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> Session:
        data = await self._fetch_conversation(session_id)
        return self._to_session(data, replay_token)

    async def stream_events(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
        since_seq: int = 0,
    ) -> AsyncIterator[Event]:
        last_status: Optional[str] = None

        async def fetch_session() -> Session:
            return await self.get_session(session_id, replay_token)

        async def fetch_new_events(cursor: Optional[str]) -> tuple[list[Event], Optional[str]]:
            nonlocal last_status
            session = await self.get_session(session_id, replay_token)
            raw_status_map = {v: k for k, v in _STATUS_MAP.items()}
            events: list[Event] = []
            current_raw = raw_status_map.get(session.status, session.status)

            if current_raw != last_status:
                last_status = current_raw
                if current_raw == "waiting_for_confirmation":
                    events.append(
                        Event(
                            kind="requires_input",
                            session_id=session_id,
                            provider="openhands",
                            ts=datetime.now(timezone.utc),
                            seq=0,
                            data={"question": "Agent needs confirmation"},
                        )
                    )
                elif current_raw not in ("running", "starting", "ready"):
                    events.append(
                        Event(
                            kind="provider_event",
                            session_id=session_id,
                            provider="openhands",
                            ts=datetime.now(timezone.utc),
                            seq=0,
                            data={"type": "status_transition", "status": current_raw},
                        )
                    )
            return events, None

        async for ev in polling_stream(
            provider="openhands",
            session_id=session_id,
            fetch_session=fetch_session,
            fetch_new_events=fetch_new_events,
        ):
            yield ev

    async def cancel_session(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None:
        raise UnsupportedCapability("openhands", "cancel_session")

    async def send_message(
        self,
        session_id: str,
        message: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None:
        # Only valid when waiting_for_confirmation
        await self._req(
            "POST",
            f"/api/v1/app-conversations/{session_id}/messages",
            json={"role": "user", "content": message},
        )

    async def list_sessions(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
    ) -> SessionPage:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["next_page_id"] = cursor
        resp = await self._req("GET", "/api/v1/app-conversations/search", params=params)
        data = resp.json()
        sessions = [self._to_session(s) for s in data.get("conversations", [])]
        return SessionPage(
            sessions=sessions,
            next_cursor=data.get("next_page_id"),
            provider="openhands",
        )
