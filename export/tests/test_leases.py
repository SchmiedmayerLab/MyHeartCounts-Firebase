# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from mhc_export.cli import main
from mhc_export.run.leases import DONE, FAILED, LEASED, PENDING, LeaseLost, LocalLeaseStore, UnitLease, choose, take
from mhc_export.run.models import Unit, UnitResult
from mhc_export.run.worker import report_from_leases, work_with_leases
from tests.test_unit_e2e import TEST_KEY_HEX, build_source

NOW = datetime(2026, 10, 1, tzinfo=UTC)
TTL = timedelta(minutes=30)


def test_choose_prefers_the_same_participant_and_skips_live_leases() -> None:
    units = [
        UnitLease("a:T1"),
        UnitLease("b:T1"),
        UnitLease("b:T2"),
        UnitLease("c:T1", state=LEASED, owner="w", token="t", expires_at=NOW + TTL),
    ]
    assert choose(units, NOW, None).unit_id == "a:T1"
    assert choose(units, NOW, "b").unit_id == "b:T1"
    assert choose([u for u in units if u.unit_id.startswith("c")], NOW, None) is None
    expired = UnitLease("d:T1", state=LEASED, owner="w", token="t", expires_at=NOW - timedelta(seconds=1))
    assert choose([expired], NOW, None).unit_id == "d:T1"


def test_take_counts_attempts_and_fails_past_the_limit() -> None:
    unit = UnitLease("a:T1")
    take(unit, "w1", NOW, TTL, max_attempts=2)
    assert unit.state == LEASED and unit.attempts == 1 and unit.token
    first_token = unit.token
    unit.expires_at = NOW - timedelta(seconds=1)
    take(unit, "w2", NOW, TTL, max_attempts=2)
    assert unit.owner == "w2" and unit.token != first_token and "expired" in unit.errors[0]
    unit.expires_at = NOW - timedelta(seconds=1)
    take(unit, "w3", NOW, TTL, max_attempts=2)
    assert unit.state == FAILED and unit.token is None


def test_local_store_fencing_and_expiry(tmp_path: Path) -> None:
    store = LocalLeaseStore(tmp_path / "leases")
    assert store.seed(["u:A", "u:B"]) == 2 and store.seed(["u:A", "u:B"]) == 0
    first = store.claim("w1", timedelta(milliseconds=50), max_attempts=3)
    assert first and first.unit_id == "u:A"
    time.sleep(0.1)
    second = store.claim("w2", TTL, max_attempts=3, prefer_uid="u")
    assert second and second.unit_id == "u:A" and second.token != first.token  # the expired lease was taken over
    with pytest.raises(LeaseLost):
        store.complete("u:A", first.token, {"result": {}})  # the stale worker cannot complete it
    store.complete("u:A", second.token, {"context": {}, "result": UnitResult().model_dump()})
    states = {u.unit_id: u.state for u in store.all()}
    assert states == {"u:A": DONE, "u:B": PENDING}


def test_failed_units_retry_until_the_limit(tmp_path: Path) -> None:
    store = LocalLeaseStore(tmp_path / "leases")
    store.seed(["u:A"])
    units = {"u:A": Unit(unit_id="u:A", uid="u", sample_type="A")}
    calls = []

    def boom(unit: Unit, deps) -> UnitResult:
        calls.append(unit.unit_id)
        raise RuntimeError("transient")

    done, failed = work_with_leases(units, None, store, owner="w", context={}, ttl=TTL, max_attempts=3, process=boom)
    assert (done, failed) == (0, 3) and len(calls) == 3
    lease = store.all()[0]
    assert lease.state == FAILED and len(lease.errors) == 3
    report, unit_results = report_from_leases("r", list(units.values()), store, planned_units=1)
    assert report.units_failed == 1 and "transient" in unit_results["u:A"]["error"]


def test_report_refuses_mixed_worker_configurations(tmp_path: Path) -> None:
    store = LocalLeaseStore(tmp_path / "leases")
    store.seed(["u:A", "u:B"])
    for ctx in ({"max_unit_rows": 5}, {"max_unit_rows": 6}):
        lease = store.claim("w", TTL, max_attempts=3)
        store.complete(lease.unit_id, lease.token, {"context": ctx, "result": UnitResult().model_dump()})
    units = [Unit(unit_id=u, uid="u", sample_type=u[2:]) for u in ("u:A", "u:B")]
    with pytest.raises(ValueError, match="different configurations"):
        report_from_leases("r", units, store, planned_units=2)


def test_two_worker_processes_share_one_manifest(tmp_path: Path) -> None:
    src = tmp_path / "src"
    for uid in ("p1", "p2", "p3"):
        build_source(src, uid=uid)
    state = tmp_path / "state"
    manifest = state / "runs" / "r1" / "manifest.jsonl"
    assert (
        main(["plan", "--source", str(src), "--manifest", str(manifest), "--run-id", "r1", "--eligibility", "none"])
        == 0
    )
    leases = f"local:{tmp_path / 'leases'}"
    work = [
        sys.executable,
        "-m",
        "mhc_export.cli",
        "work",
        "--manifest",
        str(manifest),
        "--state",
        str(state),
        "--run-id",
        "r1",
        "--participants",
        str(tmp_path / "p.json"),
        "--key-hex",
        TEST_KEY_HEX,
        "--allow-test-key",
        "--accept-legacy",
        "--leases",
        leases,
    ]
    procs = [
        subprocess.Popen([*work, "--worker-id", f"w{i}"], cwd=Path(__file__).resolve().parents[1]) for i in range(2)
    ]
    assert [p.wait(timeout=120) for p in procs] == [0, 0]
    assert (
        main(["report", "--manifest", str(manifest), "--state", str(state), "--run-id", "r1", "--leases", leases]) == 0
    )
    report = json.loads((state / "runs" / "r1" / "report.json").read_text())
    assert report["report"]["units_done"] == 9 and report["report"]["units_failed"] == 0
    # the same manifest worked by one process without leases yields the same rows
    single = tmp_path / "single"
    assert main([*work[3:-2], "--state", str(single)]) == 0
    expected = json.loads((single / "runs" / "r1" / "report.json").read_text())["report"]
    assert report["report"]["rows_out"] == expected["rows_out"] == 18
    assert report["report"]["envelope_sha256"] == expected["envelope_sha256"]
    owners = {u.owner for u in LocalLeaseStore(tmp_path / "leases" / "r1").all()}
    assert owners == {None}  # every lease was released on completion
