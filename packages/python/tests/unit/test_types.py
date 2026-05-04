from __future__ import annotations

import pytest
from datetime import datetime, timezone
from omniharness.types import (
    Artifact,
    ReplayToken,
    Session,
    SessionOptions,
    Source,
)


class TestSourceParse:
    def test_github(self):
        s = Source.parse("github://owner/repo@main")
        assert s.kind == "github"
        assert s.branch == "main"
        assert s.uri == "github://owner/repo@main"

    def test_github_no_branch(self):
        s = Source.parse("github://owner/repo")
        assert s.kind == "github"
        assert s.branch is None

    def test_gitlab(self):
        s = Source.parse("gitlab://group/project@feature")
        assert s.kind == "gitlab"
        assert s.branch == "feature"

    def test_bitbucket(self):
        s = Source.parse("bitbucket://workspace/repo@dev")
        assert s.kind == "bitbucket"
        assert s.branch == "dev"

    def test_none(self):
        s = Source.parse("none:")
        assert s.kind == "none"

    def test_local(self):
        s = Source.parse("local:///path/to/repo")
        assert s.kind == "local"

    def test_invalid(self):
        with pytest.raises(ValueError, match="Unrecognised source URI"):
            Source.parse("ftp://unknown")


class TestReplayToken:
    def test_round_trip(self):
        data = {"session_id": "ses_123", "agent_id": "agt_456", "env_id": "env_789"}
        token = ReplayToken._encode(data)
        assert token._decode() == data

    def test_string_round_trip(self):
        data = {"session_id": "ses_123"}
        token = ReplayToken._encode(data)
        token_str = str(token)
        reconstructed = ReplayToken.from_string(token_str)
        assert reconstructed._decode() == data

    def test_empty_dict(self):
        token = ReplayToken._encode({})
        assert token._decode() == {}

    def test_from_string(self):
        token = ReplayToken._encode({"key": "value"})
        s = str(token)
        token2 = ReplayToken.from_string(s)
        assert str(token2) == s

    def test_str_is_safe(self):
        token = ReplayToken._encode({"session_id": "ses_001"})
        s = str(token)
        # Should not contain provider-internal fields in readable form
        assert "ses_001" not in s  # base64-encoded, not plaintext


class TestSessionPullRequestUrl:
    def _make_session(self, artifacts: list) -> Session:
        return Session(
            id="ses_1",
            provider="jules",
            status="completed",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
            artifacts=artifacts,
        )

    def test_no_artifacts(self):
        s = self._make_session([])
        assert s.pull_request_url is None

    def test_pr_artifact(self):
        art = Artifact(
            kind="pull_request", provider="jules", url="https://github.com/owner/repo/pull/1"
        )
        s = self._make_session([art])
        assert s.pull_request_url == "https://github.com/owner/repo/pull/1"

    def test_non_pr_artifact(self):
        art = Artifact(kind="file", provider="jules", url="https://example.com/file")
        s = self._make_session([art])
        assert s.pull_request_url is None

    def test_mixed_artifacts(self):
        arts = [
            Artifact(kind="file", provider="jules", url="https://example.com/file"),
            Artifact(kind="pull_request", provider="jules", url="https://github.com/pr/42"),
        ]
        s = self._make_session(arts)
        assert s.pull_request_url == "https://github.com/pr/42"

    def test_pr_artifact_no_url(self):
        art = Artifact(kind="pull_request", provider="jules", url=None)
        s = self._make_session([art])
        assert s.pull_request_url is None
