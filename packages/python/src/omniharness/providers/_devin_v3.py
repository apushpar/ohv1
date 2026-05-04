from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

import httpx

from .._streaming import polling_stream
from ..errors import ProviderError, classify_http_error
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

_log = logging.getLogger(__name__)

_STATUS_MAP: dict[str, SessionStatus] = {
    "running": "in_progress",
    "exit": "completed",
    "error": "failed",
    "suspended": "paused",
}


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class DevinV3Provider:
    id: ProviderId = "devin"
    capabilities = ProviderCapabilities(
        streaming=False,
        cancellation=True,
        list_sessions=True,
        send_message=True,
        plan_approval=False,
        tool_results=False,
        file_upload=False,
    )

    def __init__(self, api_key: str, org_id: str) -> None:
        if not org_id:
            raise ProviderError(
                "invalid_request",
                "DEVIN_ORG_ID is required for the Devin provider",
                "devin",
                False,
            )
        self._org_id = org_id
        self._http = httpx.AsyncClient(
            base_url=f"https://api.devin.ai/v3/organizations/{org_id}",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30.0,
        )

    async def _req(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = await self._http.request(method, path, **kwargs)
        if resp.status_code >= 400:
            raise classify_http_error(
                resp.status_code,
                resp.json() if resp.content else {},
                "devin",
                dict(resp.headers),
            )
        return resp

    def _build_prompt(self, opts: SessionOptions) -> str:
        po = opts.provider_options or {}
        parts: list[str] = []
        if opts.source and opts.source.uri != "none:":
            parts.append(f"Repository: {opts.source.uri}\n")
        skills = po.get("skills", [])
        if skills:
            skill_blocks = ["---", "# Context"]
            for sk in skills:
                skill_blocks.append(f"## {sk['name']}\n{sk['content']}")
            skill_blocks.append("---")
            parts.append("\n".join(skill_blocks) + "\n")
        parts.append(opts.prompt)
        if po.get("auto_create_pr"):
            parts.append(
                "\n\nWhen complete, open a pull request with your changes."
            )
        return "".join(parts)

    def _to_session(self, data: dict[str, Any]) -> Session:
        session_id = data.get("session_id", data.get("id", ""))
        raw_status = data.get("status", "running")
        status: SessionStatus = _STATUS_MAP.get(raw_status, "in_progress")
        artifacts: list[Artifact] = []
        for att in data.get("attachments", []):
            artifacts.append(
                Artifact(
                    kind="file",
                    provider="devin",
                    url=att.get("url"),
                    name=att.get("name"),
                    data=att,
                )
            )
        if pr_url := data.get("pull_request_url"):
            artifacts.append(
                Artifact(kind="pull_request", provider="devin", url=pr_url)
            )
        token = ReplayToken._encode(
            {
                "session_id": session_id,
                "org_id": self._org_id,
                "url": data.get("url", ""),
            }
        )
        ts_str = data.get("created_at", datetime.now(timezone.utc).isoformat())
        return Session(
            id=session_id,
            provider="devin",
            status=status,
            created_at=_parse_dt(ts_str),
            updated_at=_parse_dt(data.get("updated_at", ts_str)),
            artifacts=artifacts,
            replay_token=token,
        )

    async def create_session(self, opts: SessionOptions) -> Session:
        po = opts.provider_options or {}
        if po.get("mcp_servers"):
            _log.debug("devin: mcp_servers in provider_options is not supported and will be ignored")
        body: dict[str, Any] = {"prompt": self._build_prompt(opts)}
        if opts.idempotency_key:
            body["idempotency_key"] = opts.idempotency_key
        if create_as := po.get("create_as_user_id"):
            body["create_as_user_id"] = create_as
        resp = await self._req("POST", "/sessions", json=body)
        return self._to_session(resp.json())

    async def get_session(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> Session:
        resp = await self._req("GET", f"/sessions/{session_id}")
        return self._to_session(resp.json())

    async def stream_events(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
        since_seq: int = 0,
    ) -> AsyncIterator[Event]:
        seen_msg_indices: set[int] = set()
        seen_attachment_ids: set[str] = set()

        async def fetch_session() -> Session:
            return await self.get_session(session_id, replay_token)

        async def fetch_new_events(
            cursor: Optional[str],
        ) -> tuple[list[Event], Optional[str]]:
            events: list[Event] = []

            # Poll messages
            msg_resp = await self._req("GET", f"/sessions/{session_id}/messages")
            for i, msg in enumerate(msg_resp.json().get("messages", [])):
                if i in seen_msg_indices:
                    continue
                seen_msg_indices.add(i)
                text = msg.get("message", msg.get("text", ""))
                if text:
                    events.append(
                        Event(
                            kind="message",
                            session_id=session_id,
                            provider="devin",
                            ts=_parse_dt(
                                msg.get("created_at", datetime.now(timezone.utc).isoformat())
                            ),
                            seq=0,
                            data={"text": text},
                            raw=msg,
                        )
                    )

            # Poll attachments
            att_resp = await self._req("GET", f"/sessions/{session_id}/attachments")
            for att in att_resp.json().get("attachments", []):
                att_id = att.get("id", "")
                if att_id in seen_attachment_ids:
                    continue
                seen_attachment_ids.add(att_id)
                artifact = Artifact(
                    kind="file",
                    provider="devin",
                    url=att.get("url"),
                    name=att.get("name"),
                    data=att,
                )
                events.append(
                    Event(
                        kind="artifact",
                        session_id=session_id,
                        provider="devin",
                        ts=_parse_dt(
                            att.get("created_at", datetime.now(timezone.utc).isoformat())
                        ),
                        seq=0,
                        data={"artifact": artifact},
                        raw=att,
                    )
                )

            return events, None

        async for ev in polling_stream(
            provider="devin",
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
        await self._req("DELETE", f"/sessions/{session_id}")

    async def send_message(
        self,
        session_id: str,
        message: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None:
        await self._req(
            "POST",
            f"/sessions/{session_id}/messages",
            json={"message": message},
        )

    async def list_sessions(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
    ) -> SessionPage:
        params: dict[str, Any] = {"first": limit}
        if cursor:
            params["after"] = cursor
        resp = await self._req("GET", "/sessions", params=params)
        data = resp.json()
        sessions = [self._to_session(s) for s in data.get("sessions", [])]
        return SessionPage(
            sessions=sessions,
            next_cursor=data.get("end_cursor"),
            provider="devin",
        )
