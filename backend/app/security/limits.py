"""In-process request limits and processing-slot caps.

Both live in this process's memory: run the backend as ONE process (uvicorn --workers 1), which the
file storage needs anyway. Nothing here is persisted; a restart starts with fresh counters.
"""

import math
import threading
import time
from collections.abc import Callable


class RateLimiter:
    """Token buckets keyed by (bucket name, client). `capacity` requests per `period_s`, refilled evenly."""

    def __init__(self, clock: Callable[[], float] = time.monotonic, max_keys: int = 50_000):
        self.clock = clock
        self._max_keys = max_keys
        self._buckets: dict[tuple[str, str], tuple[float, float]] = {}
        self._lock = threading.Lock()

    def hit(self, bucket: str, client: str, capacity: int, period_s: float) -> int:
        """Spend one token. Returns 0 if allowed, otherwise the whole seconds to wait before retrying."""
        if capacity <= 0:
            return math.ceil(period_s)
        rate = capacity / period_s
        with self._lock:
            now = self.clock()
            tokens, last = self._buckets.get((bucket, client), (float(capacity), now))
            tokens = min(float(capacity), tokens + (now - last) * rate)
            if tokens >= 1.0:
                self._buckets[(bucket, client)] = (tokens - 1.0, now)
                if len(self._buckets) > self._max_keys:
                    self._prune(now)
                return 0
            self._buckets[(bucket, client)] = (tokens, now)
            return max(1, math.ceil((1.0 - tokens) / rate))

    def _prune(self, now: float) -> None:
        # Forget clients idle for a day; their buckets would be full again anyway (all periods are <= 1 day).
        stale = [k for k, (_, last) in self._buckets.items() if now - last > 86_400]
        for k in stale:
            del self._buckets[k]

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


class Slot:
    """One taken processing slot. `release()` is idempotent, so every exit path may call it."""

    def __init__(self, owner: "Slots"):
        self._owner = owner
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._owner._give_back()


class Slots:
    """A counter of concurrently running jobs of one kind; `try_acquire` never waits."""

    def __init__(self):
        self._used = 0
        self._lock = threading.Lock()

    @property
    def in_use(self) -> int:
        return self._used

    def try_acquire(self, limit: int) -> Slot | None:
        with self._lock:
            if self._used >= max(1, limit):
                return None
            self._used += 1
        return Slot(self)

    def _give_back(self) -> None:
        with self._lock:
            self._used = max(0, self._used - 1)


limiter = RateLimiter()


def enforce(bucket: str, client: str, capacity: int, period_s: float, what: str) -> None:
    """Spend one token from (bucket, client) or raise 429 with Retry-After."""
    from app.errors import RateLimited

    wait = limiter.hit(bucket, client, capacity, period_s)
    if wait:
        raise RateLimited(f"Too many {what}. Please try again in {wait} s.", retry_after=wait)


upload_slots = Slots()
interpretation_slots = Slots()
login_slots = Slots()  # each password check needs ~32 MiB (scrypt) and a worker thread
