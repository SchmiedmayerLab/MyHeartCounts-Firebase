# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Download a unit's objects ahead of the consumer, strictly in order and within a byte budget."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Protocol

DEFAULT_WINDOW_BYTES = 64 * 1024 * 1024


class Sized(Protocol):
    @property
    def uri(self) -> str: ...

    @property
    def size(self) -> int: ...


class Prefetcher[T: Sized]:
    """Use as `with Prefetcher(objects, read, threads) as stream: for obj, data in stream: ...`.

    Downloads are submitted only as the consumer advances, so at most `window_bytes` of compressed input is held
    (in flight, ready, and the object being consumed), except that an object larger than the window is fetched alone.
    Objects are yielded in their given order, and a failed read surfaces when its object is reached, as
    RuntimeError naming that object. Leaving the block cancels queued downloads and waits for running ones.
    """

    def __init__(
        self,
        objects: Sequence[T],
        read: Callable[[T], bytes],
        threads: int,
        window_bytes: int = DEFAULT_WINDOW_BYTES,
        on_abort: Callable[[], None] | None = None,
    ) -> None:
        if threads < 1:
            raise ValueError("threads must be at least 1")
        self._objects = list(objects)
        self._read = read
        self._threads = threads
        self._window = window_bytes
        self._max_pending = 2 * threads
        self._next = 0
        self._pending: deque[tuple[T, Future[bytes]]] = deque()
        self._held = 0  # bytes of submitted, ready and currently consumed objects
        self._consumed_size = 0
        self._pool: ThreadPoolExecutor | None = None
        self._on_abort = on_abort

    def __enter__(self) -> Prefetcher[T]:
        self._pool = ThreadPoolExecutor(max_workers=self._threads, thread_name_prefix="fetch")
        return self

    def __exit__(self, exc_type: type[BaseException] | None, *_: object) -> None:
        if exc_type is not None and self._on_abort is not None:
            self._on_abort()  # running downloads stop retrying, so leaving waits at most one attempt
        for _, future in self._pending:
            future.cancel()
        self._pending.clear()
        if self._pool is not None:
            self._pool.shutdown(wait=True, cancel_futures=True)
            self._pool = None

    def __iter__(self) -> Prefetcher[T]:
        return self

    def __next__(self) -> tuple[T, bytes]:
        if self._pool is None:
            raise RuntimeError("use Prefetcher inside a with block")
        self._held -= self._consumed_size
        self._consumed_size = 0
        self._fill()
        if not self._pending:
            raise StopIteration
        obj, future = self._pending.popleft()
        self._consumed_size = obj.size
        try:
            return obj, future.result()
        except Exception as exc:  # noqa: BLE001 - any read failure fails the unit
            raise RuntimeError(f"read failed for {obj.uri}: {type(exc).__name__}: {exc}") from exc
        finally:
            del future

    def _fill(self) -> None:
        assert self._pool is not None
        while self._next < len(self._objects) and len(self._pending) < self._max_pending:
            obj = self._objects[self._next]
            idle = not self._pending and self._held == 0
            if not idle and self._held + obj.size > self._window:
                return
            self._pending.append((obj, self._pool.submit(self._read, obj)))
            self._held += obj.size
            self._next += 1
