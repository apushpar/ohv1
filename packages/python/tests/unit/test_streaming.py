from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from omniharness._streaming import polling_stream
from omniharness.types import Event, Session, Artifact


def _make_session(status: str) -> Session:
    return Session(
        id="ses_1",
        provider="jules",
        status=status,  # type: ignore[arg-type]
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


def _make_event(kind: str, seq: int = 0) -> Event:
    return Event(
        kind=kind,  # type: ignore[arg-type]
        session_id="ses_1",
        provider="jules",
        ts=datetime.now(timezone.utc),
        seq=seq,
        data={},
    )


class TestPollingStream:
    async def test_emits_events_then_terminal(self):
        call_count = 0

        async def fetch_session() -> Session:
            nonlocal call_count
            call_count += 1
            if call_count >= 3:
                return _make_session("completed")
            return _make_session("in_progress")

        async def fetch_new_events(cursor):
            if call_count == 1:
                return [_make_event("message")], None
            return [], None

        with patch("omniharness._streaming.asyncio.sleep", new_callable=AsyncMock):
            events: list[Event] = []
            async for ev in polling_stream(
                provider="jules",
                session_id="ses_1",
                fetch_session=fetch_session,
                fetch_new_events=fetch_new_events,
            ):
                events.append(ev)

        kinds = [e.kind for e in events]
        assert "message" in kinds
        assert kinds[-1] == "status"
        status_ev = events[-1]
        assert status_ev.data["value"] == "completed"

    async def test_seq_increments(self):
        call_count = 0

        async def fetch_session() -> Session:
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                return _make_session("completed")
            return _make_session("in_progress")

        async def fetch_new_events(cursor):
            if call_count == 1:
                return [_make_event("message"), _make_event("tool_activity")], None
            return [], None

        with patch("omniharness._streaming.asyncio.sleep", new_callable=AsyncMock):
            events: list[Event] = []
            async for ev in polling_stream(
                provider="jules",
                session_id="ses_1",
                fetch_session=fetch_session,
                fetch_new_events=fetch_new_events,
            ):
                events.append(ev)

        seqs = [e.seq for e in events]
        assert seqs == sorted(seqs)
        assert len(set(seqs)) == len(seqs)

    async def test_terminal_stops_generator(self):
        async def fetch_session() -> Session:
            return _make_session("failed")

        async def fetch_new_events(cursor):
            return [], None

        with patch("omniharness._streaming.asyncio.sleep", new_callable=AsyncMock):
            events: list[Event] = []
            async for ev in polling_stream(
                provider="jules",
                session_id="ses_1",
                fetch_session=fetch_session,
                fetch_new_events=fetch_new_events,
            ):
                events.append(ev)

        assert len(events) == 1
        assert events[0].kind == "status"
        assert events[0].data["value"] == "failed"

    async def test_keepalive_emitted_when_idle(self):
        call_count = 0
        loop_time = 0.0

        async def fetch_session() -> Session:
            nonlocal call_count
            call_count += 1
            if call_count >= 3:
                return _make_session("completed")
            return _make_session("in_progress")

        async def fetch_new_events(cursor):
            return [], None

        async def fake_sleep(delay: float) -> None:
            pass

        # Simulate time advancing past keepalive threshold
        with patch("omniharness._streaming.asyncio.sleep", side_effect=fake_sleep):
            with patch(
                "omniharness._streaming.asyncio.get_event_loop"
            ) as mock_loop:
                mock_loop_inst = MagicMock()
                times = [0.0, 35.0, 35.0, 35.0, 35.0, 35.0]
                mock_loop_inst.time.side_effect = times
                mock_loop.return_value = mock_loop_inst

                events: list[Event] = []
                async for ev in polling_stream(
                    provider="jules",
                    session_id="ses_1",
                    fetch_session=fetch_session,
                    fetch_new_events=fetch_new_events,
                    keepalive_secs=30.0,
                ):
                    events.append(ev)

        keepalives = [e for e in events if e.kind == "provider_event" and e.data.get("type") == "keep_alive"]
        assert len(keepalives) >= 1


class TestClaudeToolActivityCollapse:
    """Test that agent.tool_use + agent.tool_result are collapsed into tool_activity."""

    async def test_tool_use_result_collapsed(self):
        from unittest.mock import AsyncMock, patch
        import json

        # Build SSE lines
        tool_use_ev = {
            "id": "ev_1",
            "type": "agent.tool_use",
            "tool_name": "bash",
            "input": {"command": "ls"},
            "created_at": "2026-01-01T00:00:00Z",
        }
        tool_result_ev = {
            "id": "ev_2",
            "type": "agent.tool_result",
            "tool_use_id": "tu_1",
            "content": "file1.py file2.py",
            "created_at": "2026-01-01T00:00:01Z",
        }
        idle_ev = {
            "id": "ev_3",
            "type": "session.status_idle",
            "end_reason": "end_turn",
            "created_at": "2026-01-01T00:00:02Z",
        }

        async def fake_sse(http, session_id, since):
            for ev in [tool_use_ev, tool_result_ev, idle_ev]:
                yield ev

        from omniharness.providers._claude_2026_04 import Claude202604Provider

        provider = object.__new__(Claude202604Provider)
        provider._api_key = "test"
        provider._http = MagicMock()

        with patch("omniharness.providers._claude_2026_04.claude_sse_stream", side_effect=fake_sse):
            events = []
            async for ev in provider.stream_events("ses_1"):
                events.append(ev)

        tool_activities = [e for e in events if e.kind == "tool_activity"]
        assert len(tool_activities) == 1
        ta = tool_activities[0]
        assert ta.data["tool"] == "bash"
        assert ta.data["summary"] == "file1.py file2.py"

    async def test_pending_tool_use_flushed_on_end(self):
        """If session ends with a pending tool_use (no result), emit as provider_event."""
        tool_use_ev = {
            "id": "ev_1",
            "type": "agent.tool_use",
            "tool_name": "bash",
            "input": {},
            "created_at": "2026-01-01T00:00:00Z",
        }
        idle_ev = {
            "id": "ev_2",
            "type": "session.status_idle",
            "end_reason": "end_turn",
            "created_at": "2026-01-01T00:00:01Z",
        }

        async def fake_sse(http, session_id, since):
            for ev in [tool_use_ev, idle_ev]:
                yield ev

        from omniharness.providers._claude_2026_04 import Claude202604Provider
        from unittest.mock import MagicMock

        provider = object.__new__(Claude202604Provider)
        provider._api_key = "test"
        provider._http = MagicMock()

        with patch("omniharness.providers._claude_2026_04.claude_sse_stream", side_effect=fake_sse):
            events = []
            async for ev in provider.stream_events("ses_1"):
                events.append(ev)

        provider_events = [
            e for e in events if e.kind == "provider_event" and e.data.get("type") == "agent.tool_use"
        ]
        assert len(provider_events) == 1
