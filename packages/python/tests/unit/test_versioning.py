from __future__ import annotations

import warnings
import pytest

from omniharness._client import OmniHarness, _DEPRECATED
from omniharness.errors import AdapterDeprecatedError, ProviderLanguageError, ProviderError


class TestAdapterResolution:
    def test_default_adapter_resolved(self):
        client = OmniHarness(provider_keys={"jules": "fake_key"})
        provider = client._get_provider("jules")
        assert provider.id == "jules"

    def test_explicit_version_resolved(self):
        client = OmniHarness(provider_keys={"jules": "fake_key"})
        provider = client._get_provider("jules", "v1alpha")
        assert provider.id == "jules"

    def test_unknown_version_raises_deprecated_error(self):
        client = OmniHarness(provider_keys={"jules": "fake_key"})
        with pytest.raises(AdapterDeprecatedError) as exc_info:
            client._get_provider("jules", "v0")
        assert exc_info.value.provider == "jules"
        assert exc_info.value.version == "v0"

    def test_cursor_raises_language_error(self):
        client = OmniHarness(provider_keys={"cursor": "fake_key"})
        with pytest.raises(ProviderLanguageError) as exc_info:
            client._get_provider("cursor")
        assert exc_info.value.provider == "cursor"
        assert exc_info.value.required_language == "typescript"

    def test_devin_missing_org_id_raises(self):
        client = OmniHarness(
            provider_keys={"devin": "cog_fake_key", "devin_org_id": ""}
        )
        import os
        old = os.environ.get("DEVIN_ORG_ID", "UNSET")
        try:
            os.environ.pop("DEVIN_ORG_ID", None)
            with pytest.raises(ProviderError) as exc_info:
                client._get_provider("devin")
            assert exc_info.value.kind == "invalid_request"
        finally:
            if old != "UNSET":
                os.environ["DEVIN_ORG_ID"] = old

    def test_deprecated_emits_warning(self):
        _DEPRECATED.add(("jules", "v1alpha"))
        try:
            client = OmniHarness(provider_keys={"jules": "fake_key"})
            with warnings.catch_warnings(record=True) as w:
                warnings.simplefilter("always")
                client._get_provider("jules", "v1alpha")
            deprecation_warnings = [x for x in w if issubclass(x.category, DeprecationWarning)]
            assert len(deprecation_warnings) >= 1
            assert "deprecated" in str(deprecation_warnings[0].message).lower()
        finally:
            _DEPRECATED.discard(("jules", "v1alpha"))

    def test_provider_cached(self):
        client = OmniHarness(provider_keys={"jules": "fake_key"})
        p1 = client._get_provider("jules")
        p2 = client._get_provider("jules")
        assert p1 is p2

    def test_capabilities_returned(self):
        client = OmniHarness()
        caps = client.capabilities("jules")
        assert caps.plan_approval is True
        assert caps.streaming is False
        caps_claude = client.capabilities("claude")
        assert caps_claude.tool_results is True
        assert caps_claude.file_upload is True
        caps_oh = client.capabilities("openhands")
        assert caps_oh.cancellation is False
        caps_cursor = client.capabilities("cursor")
        assert caps_cursor.list_sessions is False
        caps_devin = client.capabilities("devin")
        assert caps_devin.send_message is True
