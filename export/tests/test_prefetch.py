# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import random
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from mhc_export.config import GroveSettings, IdentityConfig
from mhc_export.identity.participants import LocalParticipantLookup
from mhc_export.io.blobstore import LocalBlobStore, RoutedStore
from mhc_export.io.prefetch import Prefetcher
from mhc_export.run.unit import Deps, UnitTooLarge, process_unit
from mhc_export.sources.bucket import plan_units
from mhc_export.transform.specs import default_registry
from tests.conftest import TEST_KEY
from tests.test_unit_e2e import build_source

HR = "HKQuantityTypeIdentifierHeartRate"


@dataclass(frozen=True)
class Obj:
    uri: str
    size: int


def _objects(sizes: list[int]) -> list[Obj]:
    return [Obj(f"o{i}", s) for i, s in enumerate(sizes)]


def _slow_read(fail: set[str] = frozenset()):
    rng = random.Random(7)
    delays = {f"o{i}": rng.random() / 200 for i in range(100)}

    def read(obj: Obj) -> bytes:
        time.sleep(delays[obj.uri])
        if obj.uri in fail:
            raise OSError(f"boom {obj.uri}")
        return obj.uri.encode()

    return read


def test_objects_come_back_in_order_whatever_finishes_first() -> None:
    objs = _objects([10] * 40)
    with Prefetcher(objs, _slow_read(), threads=8) as stream:
        assert [data.decode() for _, data in stream] == [o.uri for o in objs]


def test_the_first_failing_object_in_order_is_reported_and_threads_end() -> None:
    before = threading.active_count()
    objs = _objects([10] * 20)
    with (
        pytest.raises(RuntimeError, match=r"read failed for o3: OSError: boom o3"),
        Prefetcher(objs, _slow_read({"o3", "o6"}), threads=8) as stream,
    ):
        for _ in stream:
            pass
    assert threading.active_count() == before


def test_a_consumer_error_stops_downloads_and_threads_end() -> None:
    before = threading.active_count()
    started: list[str] = []

    def read(obj: Obj) -> bytes:
        started.append(obj.uri)
        time.sleep(0.01)
        return b""

    with pytest.raises(ValueError, match="stop"), Prefetcher(_objects([1] * 200), read, threads=4) as stream:
        for obj, _ in stream:
            if obj.uri == "o2":
                raise ValueError("stop")
    assert threading.active_count() == before and len(started) < 20


@pytest.mark.parametrize(
    "sizes",
    [[30] * 30, [5, 90, 5, 5, 200, 5, 60, 60, 60], [300, 40, 40, 40], [40, 40, 40, 300], [99, 99, 99, 0, 0, 101]],
)
def test_held_bytes_stay_within_the_window_and_nothing_is_skipped(sizes: list[int]) -> None:
    window = 100
    lock = threading.Lock()
    held = peak = 0

    def read(obj: Obj) -> bytes:
        nonlocal held, peak
        with lock:
            held += obj.size
            peak = max(peak, held)
        time.sleep(0.002)
        return b""

    seen: list[str] = []
    with Prefetcher(_objects(sizes), read, threads=8, window_bytes=window) as stream:
        for obj, _ in stream:
            seen.append(obj.uri)
            time.sleep(0.001)
            with lock:
                held -= obj.size
    assert peak <= max(window, max(sizes)) and seen == [o.uri for o in _objects(sizes)]


def test_leaving_on_any_error_tells_the_store_to_stop_retrying() -> None:
    calls: list[str] = []
    for error in (ValueError, KeyboardInterrupt):
        with (
            pytest.raises(error),
            Prefetcher(_objects([1, 1]), lambda o: b"", 2, on_abort=lambda: calls.append("x")),
        ):
            raise error()
    with Prefetcher(_objects([1, 1]), lambda o: b"", 2, on_abort=lambda: calls.append("y")) as stream:
        list(stream)
    assert calls == ["x", "x"]


class SlowStore(LocalBlobStore):
    """Earlier objects in the manifest take longer, so completion order is the reverse of manifest order."""

    def __init__(self, root: Path, delays: dict[str, float]) -> None:
        super().__init__(root)
        self._delays = delays

    def read(self, uri: str, generation: int | None = None, stop=None) -> bytes:
        time.sleep(self._delays.get(uri, 0.0))
        return super().read(uri, generation, stop)


def _deps(tmp_path: Path, src: Path, out: str, threads: int, delays: dict[str, float] | None = None, **kw) -> Deps:
    return Deps(
        store=RoutedStore(SlowStore(src, delays or {}), LocalBlobStore(tmp_path / out)),
        registry=default_registry(),
        identity=IdentityConfig(TEST_KEY),
        participants=LocalParticipantLookup(tmp_path / "p.json"),
        staging_prefix="staging/r1",
        run_id="r1",
        grove=GroveSettings(accept_legacy=True),
        fetch_threads=threads,
        **kw,
    )


def test_unit_output_does_not_depend_on_the_thread_count(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    (unit,) = plan_units(LocalBlobStore(src).list(""), sample_types={HR})
    delays = {o.uri: 0.05 * (len(unit.objects) - i) for i, o in enumerate(unit.objects)}
    results = {}
    for threads in (1, 8):
        result = process_unit(unit, _deps(tmp_path, src, f"out{threads}", threads, delays))
        parts = {uri: LocalBlobStore(tmp_path / f"out{threads}").read(uri) for uri in result.parts}
        timing = {"seconds", "peak_rss_mb", "arrow_mb"}
        results[threads] = (result.model_dump(exclude=timing), parts)
    assert results[1] == results[8]


def test_unit_failures_leave_no_fetch_threads(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    (unit,) = plan_units(LocalBlobStore(src).list(""), sample_types={HR})
    before = threading.active_count()
    with pytest.raises(UnitTooLarge):
        process_unit(unit, _deps(tmp_path, src, "out", 8, max_unit_rows=1))
    assert threading.active_count() == before
    (src / "users" / "user-abc" / "liveHealthSamples" / f"{HR}_C.json.zstd").write_bytes(b"not zstd or json")
    with pytest.raises(RuntimeError, match="unreadable_object"):
        process_unit(unit, _deps(tmp_path, src, "out", 8))
    assert threading.active_count() == before
