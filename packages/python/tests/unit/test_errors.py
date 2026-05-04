from __future__ import annotations

import pytest
from omniharness.errors import (
    AdapterDeprecatedError,
    OmniHarnessError,
    ProviderError,
    ProviderLanguageError,
    UnsupportedCapability,
    classify_http_error,
)


class TestClassifyHttpError:
    def _classify(self, status: int, retry_after: str | None = None) -> ProviderError:
        headers = {}
        if retry_after is not None:
            headers["retry-after"] = retry_after
        return classify_http_error(status, {}, "test_provider", headers)

    def test_401_auth(self):
        e = self._classify(401)
        assert e.kind == "auth"
        assert not e.retryable
        assert e.http_status == 401

    def test_403_auth(self):
        e = self._classify(403)
        assert e.kind == "auth"
        assert not e.retryable

    def test_404_not_found(self):
        e = self._classify(404)
        assert e.kind == "not_found"
        assert not e.retryable

    def test_429_rate_limit_retryable(self):
        e = self._classify(429, retry_after="5")
        assert e.kind == "rate_limit"
        assert e.retryable
        assert e.retry_after == 5.0

    def test_429_no_retry_after(self):
        e = self._classify(429)
        assert e.kind == "rate_limit"
        assert e.retryable
        assert e.retry_after is None

    def test_400_invalid_request(self):
        e = self._classify(400)
        assert e.kind == "invalid_request"
        assert not e.retryable

    def test_422_invalid_request(self):
        e = self._classify(422)
        assert e.kind == "invalid_request"
        assert not e.retryable

    def test_503_overloaded(self):
        e = self._classify(503)
        assert e.kind == "overloaded"
        assert e.retryable

    def test_529_overloaded(self):
        e = self._classify(529)
        assert e.kind == "overloaded"
        assert e.retryable

    def test_500_transient(self):
        e = self._classify(500)
        assert e.kind == "transient"
        assert e.retryable

    def test_502_transient(self):
        e = self._classify(502)
        assert e.kind == "transient"
        assert e.retryable

    def test_unknown_4xx_quirk(self):
        e = self._classify(418)
        assert e.kind == "provider_quirk"
        assert not e.retryable

    def test_provider_name_preserved(self):
        e = classify_http_error(500, {}, "jules", {})
        assert e.provider == "jules"


class TestErrorHierarchy:
    def test_provider_error_is_omni_error(self):
        e = ProviderError("auth", "msg", "provider", False)
        assert isinstance(e, OmniHarnessError)

    def test_unsupported_capability_message(self):
        e = UnsupportedCapability("jules", "tool_results")
        assert "jules" in str(e)
        assert "tool_results" in str(e)
        assert e.provider == "jules"
        assert e.feature == "tool_results"

    def test_provider_language_error(self):
        e = ProviderLanguageError("cursor", "typescript", "npm install omniharness")
        assert "cursor" in str(e)
        assert "typescript" in str(e)
        assert e.required_language == "typescript"

    def test_adapter_deprecated_error(self):
        e = AdapterDeprecatedError("jules", "v0", "v1alpha")
        assert "jules" in str(e)
        assert "v0" in str(e)
        assert "v1alpha" in str(e)
        assert e.provider == "jules"
        assert e.version == "v0"
        assert e.replacement == "v1alpha"

    def test_retry_after_invalid(self):
        e = classify_http_error(429, {}, "p", {"retry-after": "not-a-number"})
        assert e.retry_after is None
