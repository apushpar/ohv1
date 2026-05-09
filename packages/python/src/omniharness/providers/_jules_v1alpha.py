from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

import httpx

from .._streaming import polling_stream
from ..errors import ProviderError, UnsupportedCapability, classify_http_error
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
    Source,
)

_BASE = "https://jules.googleapis.com/v1alpha"

_STATUS_MAP: dict[str, SessionStatus] = {
    "QUEUED": "queued",
    "PLANNING": "queued",
    "AWAITING_PLAN_APPROVAL": "awaiting_input",
    "AWAITING_USER_FEEDBACK": "awaiting_input",
    "IN_PROGRESS": "in_progress",
    "PAUSED": "paused",
    "COMPLETED": "completed",
    "FAILED": "failed",
    "CANCELLED": "cancelled",
}


def _parse_dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class JulesV1AlphaProvider:
    id: ProviderId = "jules"
    capabilities = ProviderCapabilities(
        streaming=False,
        cancellation=True,
        list_sessions=True,
        send_message=True,
        plan_approval=True,
        tool_results=False,
        file_upload=False,
    )

    def __init__(self, api_key: str) -> None:
        self._http = httpx.AsyncClient(
            base_url=_BASE,
            headers={"X-Goog-Api-Key": api_key},
            timeout=30.0,
        )

    async def _req(
        self, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        resp = await self._http.request(method, path, **kwargs)
        if resp.status_code >= 400:
            raise classify_http_error(
                resp.status_code, resp.json() if resp.content else {}, "jules", dict(resp.headers)
            )
        return resp

    def _to_session(self, data: dict[str, Any]) -> Session:
        raw_status = data.get("state", data.get("status", "QUEUED"))
        status = _STATUS_MAP.get(raw_status, "in_progress")
        artifacts: list[Artifact] = []
        for out in data.get("outputs", []):
            if pr := out.get("pullRequest"):
                artifacts.append(
                    Artifact(
                        kind="pull_request",
                        provider="jules",
                        url=pr.get("url"),
                        title=pr.get("title"),
                    )
                )
        token = ReplayToken._encode({})
        return Session(
            id=data["name"].split("/")[-1] if "/" in data.get("name", "") else data["name"],
            provider="jules",
            status=status,
            created_at=_parse_dt(data.get("createTime", datetime.now(timezone.utc).isoformat())),
            updated_at=_parse_dt(data.get("updateTime", datetime.now(timezone.utc).isoformat())),
            artifacts=artifacts,
            replay_token=token,
        )

    async def create_session(self, opts: SessionOptions) -> Session:
        po = opts.provider_options or {}
        body: dict[str, Any] = {"prompt": opts.prompt}
        if opts.title:
            body["title"] = opts.title
        if opts.source and opts.source.kind in ("github", "gitlab", "bitbucket"):
            parts = opts.source.uri.split("://", 1)[1].split("@", 1)
            repo_path = parts[0]
            branch = opts.source.branch or (parts[1] if len(parts) > 1 else None)
            owner, _, repo = repo_path.partition("/")
            source_name = f"sources/github/{owner}/{repo}"
            if not branch:
                src_resp = await self._req("GET", f"/{source_name}")
                src_data = src_resp.json()
                branch = (
                    src_data.get("githubRepo", {})
                    .get("defaultBranch", {})
                    .get("displayName")
                )
            body["sourceContext"] = {
                "source": source_name,
                "githubRepoContext": {"startingBranch": branch},
            }
        if po.get("require_plan_approval"):
            body["requirePlanApproval"] = True
        automation = po.get("auto_create_pr")
        if automation:
            body["automationMode"] = "AUTO_CREATE_PR"
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
        seen_activity_ids: set[str] = set()
        page_token: Optional[str] = None

        async def fetch_session() -> Session:
            return await self.get_session(session_id, replay_token)

        async def fetch_new_events(cursor: Optional[str]) -> tuple[list[Event], Optional[str]]:
            nonlocal page_token
            params: dict[str, Any] = {"pageSize": 100}
            if cursor:
                params["pageToken"] = cursor
            try:
                resp = await self._req("GET", f"/sessions/{session_id}/activities", params=params)
            except ProviderError as exc:
                if exc.kind == "not_found":
                    return [], cursor
                raise
            data = resp.json()
            activities = data.get("activities", [])
            next_token: Optional[str] = data.get("nextPageToken")
            events: list[Event] = []
            for act in activities:
                act_id = act.get("name", "")
                if act_id in seen_activity_ids:
                    continue
                seen_activity_ids.add(act_id)
                ev = _activity_to_event(act, session_id)
                if ev:
                    events.append(ev)
            return events, next_token

        async for ev in polling_stream(
            provider="jules",
            session_id=session_id,
            fetch_session=fetch_session,
            fetch_new_events=fetch_new_events,
            poll_base=2.0,
            poll_cap=15.0,
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
        await self._req("POST", f"/sessions/{session_id}:sendMessage", json={"prompt": message})

    async def list_sessions(
        self,
        limit: int = 20,
        cursor: Optional[str] = None,
    ) -> SessionPage:
        params: dict[str, Any] = {"pageSize": limit}
        if cursor:
            params["pageToken"] = cursor
        resp = await self._req("GET", "/sessions", params=params)
        data = resp.json()
        sessions = [self._to_session(s) for s in data.get("sessions", [])]
        return SessionPage(
            sessions=sessions,
            next_cursor=data.get("nextPageToken"),
            provider="jules",
        )

    # Extension: SupportsPlanApproval
    async def approve_plan(
        self,
        session_id: str,
        replay_token: Optional[ReplayToken] = None,
    ) -> None:
        await self._req("POST", f"/sessions/{session_id}:approvePlan", json={})


def _activity_to_event(act: dict[str, Any], session_id: str) -> Optional[Event]:
    ts_str = act.get("createTime", datetime.now(timezone.utc).isoformat())
    ts = _parse_dt(ts_str)

    if "agentMessaged" in act:
        return Event(
            kind="message",
            session_id=session_id,
            provider="jules",
            ts=ts,
            seq=0,
            data={"text": act["agentMessaged"].get("agentMessage", "")},
            raw=act,
        )
    if "progressUpdated" in act:
        tool = act["progressUpdated"].get("tool", "")
        summary = act["progressUpdated"].get("summary", "")
        return Event(
            kind="tool_activity",
            session_id=session_id,
            provider="jules",
            ts=ts,
            seq=0,
            data={"tool": tool, "summary": summary},
            raw=act,
        )
    if "planGenerated" in act:
        return Event(
            kind="provider_event",
            session_id=session_id,
            provider="jules",
            ts=ts,
            seq=0,
            data={"type": "plan_proposed", "steps": act["planGenerated"].get("steps", [])},
            raw=act,
        )
    if "userMessaged" in act:
        return Event(
            kind="provider_event",
            session_id=session_id,
            provider="jules",
            ts=ts,
            seq=0,
            data={"type": "user_message", "text": act["userMessaged"].get("userMessage", "")},
            raw=act,
        )
    # anything else → provider_event passthrough
    act_type = next((k for k in act if k not in ("name", "createTime", "originator", "id")), "unknown")
    return Event(
        kind="provider_event",
        session_id=session_id,
        provider="jules",
        ts=ts,
        seq=0,
        data={"type": act_type, "raw": act},
        raw=act,
    )
