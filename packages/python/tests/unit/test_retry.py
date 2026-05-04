from __future__ import annotations

import asyncio
import time
import pytest
from unittest.mock import AsyncMock, patch

from omniharness._retry import CircuitBreaker, _jitter, retry_async
from omniharness.errors import ProviderError


class TestJitter:
    def test_zero_attempt(self):
        for _ in range(20):
            j = _jitter(1.0, 30.0, 0)
            assert 0.0 <= j <= 1.0

    def test_increasing_cap(self):
        for attempt in range(5):
            cap = 30.0
            base = 1.0
            j = _jitter(base, cap, attempt)
            assert 0.0 <= j <= min(cap, base * (2**attempt))

    def test_cap_respected(self):
        for _ in range(20):
            j = _jitter(1.0, 5.0, 10)
            assert j <= 5.0


class TestRetryAsync:
    async def test_success_on_first_try(self):
        calls = 0

        async def fn():
            nonlocal calls
            calls += 1
            return "ok"

        result = await retry_async(fn, max_attempts=3)
        assert result == "ok"
        assert calls == 1

    async def test_retries_on_retryable_error(self):
        calls = 0

        async def fn():
            nonlocal calls
            calls += 1
            if calls < 3:
                raise ProviderError("transient", "error", "p", True)
            return "ok"

        with patch("omniharness._retry.asyncio.sleep", new_callable=AsyncMock):
            result = await retry_async(fn, max_attempts=3, base_delay=0.01)
        assert result == "ok"
        assert calls == 3

    async def test_non_retryable_raises_immediately(self):
        calls = 0

        async def fn():
            nonlocal calls
            calls += 1
            raise ProviderError("auth", "unauthorized", "p", False)

        with pytest.raises(ProviderError) as exc_info:
            await retry_async(fn, max_attempts=3)
        assert calls == 1
        assert exc_info.value.kind == "auth"

    async def test_exhausts_retries(self):
        calls = 0

        async def fn():
            nonlocal calls
            calls += 1
            raise ProviderError("transient", "error", "p", True)

        with patch("omniharness._retry.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(ProviderError):
                await retry_async(fn, max_attempts=3)
        assert calls == 3

    async def test_os_error_becomes_provider_error(self):
        async def fn():
            raise OSError("connection refused")

        with patch("omniharness._retry.asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(ProviderError) as exc_info:
                await retry_async(fn, max_attempts=3, provider="test_p")
        assert exc_info.value.kind == "transient"
        assert exc_info.value.provider == "test_p"

    async def test_retry_after_respected(self):
        calls = 0
        sleep_calls: list[float] = []

        async def fn():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ProviderError("rate_limit", "slow down", "p", True, retry_after=5.0)
            return "ok"

        async def fake_sleep(delay: float) -> None:
            sleep_calls.append(delay)

        with patch("omniharness._retry.asyncio.sleep", side_effect=fake_sleep):
            result = await retry_async(fn, max_attempts=3)
        assert result == "ok"
        assert sleep_calls[0] == 5.0


class TestCircuitBreaker:
    def test_starts_closed(self):
        cb = CircuitBreaker(failure_threshold=3)
        assert not cb.is_open

    def test_opens_after_threshold(self):
        cb = CircuitBreaker(failure_threshold=3, window_seconds=60.0, recovery_seconds=30.0)
        for _ in range(3):
            cb.record_failure()
        assert cb.is_open

    def test_success_resets(self):
        cb = CircuitBreaker(failure_threshold=2)
        cb.record_failure()
        cb.record_failure()
        assert cb.is_open
        cb.record_success()
        assert not cb.is_open

    def test_recovery_after_time(self):
        cb = CircuitBreaker(failure_threshold=2, window_seconds=60.0, recovery_seconds=0.05)
        cb.record_failure()
        cb.record_failure()
        assert cb.is_open
        time.sleep(0.1)
        assert not cb.is_open

    def test_old_failures_expire(self):
        cb = CircuitBreaker(failure_threshold=3, window_seconds=0.05)
        cb.record_failure()
        cb.record_failure()
        time.sleep(0.1)
        cb.record_failure()
        # Only 1 failure within window → not open
        assert not cb.is_open
