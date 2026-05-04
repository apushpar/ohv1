from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Optional

ProviderId = Literal["jules", "claude", "openhands", "cursor", "devin"]

SessionStatus = Literal[
    "queued",
    "in_progress",
    "awaiting_input",
    "paused",
    "completed",
    "failed",
    "cancelled",
]

EventKind = Literal[
    "message",
    "tool_activity",
    "requires_input",
    "artifact",
    "status",
    "provider_event",
]


@dataclass(frozen=True)
class ReplayToken:
    _encoded: str

    @classmethod
    def _encode(cls, data: dict[str, Any]) -> "ReplayToken":
        return cls(base64.b64encode(json.dumps(data).encode()).decode())

    def _decode(self) -> dict[str, Any]:
        return json.loads(base64.b64decode(self._encoded).decode())

    def __str__(self) -> str:
        return self._encoded

    @classmethod
    def from_string(cls, s: str) -> "ReplayToken":
        return cls(s)


@dataclass
class Source:
    uri: str
    kind: Literal["github", "gitlab", "bitbucket", "local", "none"] = "github"
    branch: Optional[str] = None

    @staticmethod
    def parse(uri: str) -> "Source":
        if uri == "none:":
            return Source(uri=uri, kind="none")
        for scheme in ("github", "gitlab", "bitbucket"):
            if uri.startswith(f"{scheme}://"):
                rest = uri[len(scheme) + 3 :]
                repo, _, branch = rest.partition("@")
                return Source(uri=uri, kind=scheme, branch=branch or None)  # type: ignore[arg-type]
        if uri.startswith("local://"):
            return Source(uri=uri, kind="local")
        raise ValueError(f"Unrecognised source URI: {uri!r}")


@dataclass
class SessionOptions:
    prompt: str
    source: Optional[Source] = None
    title: Optional[str] = None
    timeout_seconds: Optional[int] = None
    idempotency_key: Optional[str] = None
    provider_api_version: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)
    provider_options: dict[str, Any] = field(default_factory=dict)


@dataclass
class Event:
    kind: EventKind
    session_id: str
    provider: ProviderId
    ts: datetime
    seq: int
    data: dict[str, Any]
    raw: Any = None


@dataclass
class Artifact:
    kind: Literal["pull_request", "branch", "file", "screenshot", "commit"]
    provider: ProviderId
    url: Optional[str] = None
    path: Optional[str] = None
    title: Optional[str] = None
    name: Optional[str] = None
    sha: Optional[str] = None
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class Session:
    id: str
    provider: ProviderId
    status: SessionStatus
    created_at: datetime
    updated_at: datetime
    artifacts: list[Artifact] = field(default_factory=list)
    replay_token: Optional[ReplayToken] = None

    @property
    def pull_request_url(self) -> Optional[str]:
        for a in self.artifacts:
            if a.kind == "pull_request" and a.url:
                return a.url
        return None


@dataclass
class SessionPage:
    sessions: list[Session]
    next_cursor: Optional[str] = None
    provider: Optional[ProviderId] = None


@dataclass
class ProviderCapabilities:
    streaming: bool
    cancellation: bool
    list_sessions: bool
    send_message: bool
    plan_approval: bool
    tool_results: bool
    file_upload: bool
