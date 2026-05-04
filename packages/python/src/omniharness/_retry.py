from __future__ import annotations

import asyncio
import random
import time
from typing import Awaitable, Callable, TypeVar

from .errors import ProviderError

T = TypeVar("T")


async def retry_async(
    fn: Callable[[], Awaitable[T]],
    *,
    max_attempts: int = 3,
    base_delay: float = 1.0,
    cap_delay: float = 30.0,
    provider: str = "unknown",
) -> T:
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return await fn()
        except ProviderError as e:
            last_exc = e
            if not e.retryable or attempt == max_attempts - 1:
                raise
            delay = e.retry_after or _jitter(base_delay, cap_delay, attempt)
            await asyncio.sleep(delay)
        except (OSError, asyncio.TimeoutError) as e:
            last_exc = e
            if attempt == max_attempts - 1:
                raise ProviderError("transient", str(e), provider, True) from e
            await asyncio.sleep(_jitter(base_delay, cap_delay, attempt))
    raise last_exc  # type: ignore[misc]


def _jitter(base: float, cap: float, attempt: int) -> float:
    return random.uniform(0, min(cap, base * (2**attempt)))


class CircuitBreaker:
    def __init__(
        self,
        failure_threshold: int = 5,
        window_seconds: float = 60.0,
        recovery_seconds: float = 30.0,
    ):
        self._threshold = failure_threshold
        self._window = window_seconds
        self._recovery = recovery_seconds
        self._failures: list[float] = []
        self._open_since: float | None = None

    def record_failure(self) -> None:
        now = time.monotonic()
        self._failures = [t for t in self._failures if now - t < self._window]
        self._failures.append(now)
        if len(self._failures) >= self._threshold:
            self._open_since = now

    def record_success(self) -> None:
        self._failures.clear()
        self._open_since = None

    @property
    def is_open(self) -> bool:
        if self._open_since is None:
            return False
        if time.monotonic() - self._open_since > self._recovery:
            self._open_since = None
            return False
        return True
