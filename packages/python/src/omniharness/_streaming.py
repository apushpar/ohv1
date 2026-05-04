from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import AsyncIterator, Awaitable, Callable, Optional

import httpx

from .types import Event, ProviderId, Session

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


async def polling_stream(
    *,
    provider: ProviderId,
    session_id: str,
    fetch_session: Callable[[], Awaitable[Session]],
    fetch_new_events: Callable[[Optional[str]], Awaitable[tuple[list[Event], Optional[str]]]],
    poll_base: float = 1.0,
    poll_cap: float = 15.0,
    keepalive_secs: float = 30.0,
) -> AsyncIterator[Event]:
    seq = 0
    idle_count = 0
    cursor: Optional[str] = None
    last_activity = asyncio.get_event_loop().time()

    while True:
        session = await fetch_session()
        events, cursor = await fetch_new_events(cursor)

        for ev in events:
            ev.seq = seq
            seq += 1
            idle_count = 0
            last_activity = asyncio.get_event_loop().time()
            yield ev

        if session.status in TERMINAL_STATUSES:
            yield Event(
                kind="status",
                session_id=session_id,
                provider=provider,
                ts=datetime.now(timezone.utc),
                seq=seq,
                data={"value": session.status},
            )
            return

        now = asyncio.get_event_loop().time()
        if now - last_activity > keepalive_secs:
            yield Event(
                kind="provider_event",
                session_id=session_id,
                provider=provider,
                ts=datetime.now(timezone.utc),
                seq=seq,
                data={"type": "keep_alive"},
            )
            seq += 1
            last_activity = now

        await asyncio.sleep(min(poll_cap, poll_base * (2 ** min(idle_count, 4))))
        idle_count = 0 if events else idle_count + 1


async def claude_sse_stream(
    http: httpx.AsyncClient,
    session_id: str,
    since_processed_at: Optional[str],
) -> AsyncIterator[dict]:  # type: ignore[type-arg]
    seen_ids: set[str] = set()

    if since_processed_at:
        resp = await http.get(
            f"/v1/sessions/{session_id}/events",
            params={"processed_at_gt": since_processed_at},
        )
        for ev in resp.json().get("events", []):
            if ev["id"] not in seen_ids:
                seen_ids.add(ev["id"])
                yield ev

    async with http.stream("GET", f"/v1/sessions/{session_id}/events/stream") as resp:
        async for line in resp.aiter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload.strip() == "[DONE]":
                break
            data = json.loads(payload)
            ev_id = data.get("id", "")
            if ev_id and ev_id in seen_ids:
                continue
            if ev_id:
                seen_ids.add(ev_id)
            yield data
