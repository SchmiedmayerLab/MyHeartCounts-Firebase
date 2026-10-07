# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Lease-driven workers and the run report assembled from committed unit results."""

from __future__ import annotations

import contextlib
import logging
import threading
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from mhc_export.run.leases import DONE, FAILED, LeaseLost, LeaseStore
from mhc_export.run.models import RunReport, Unit, UnitResult
from mhc_export.run.unit import Deps, process_unit

log = logging.getLogger(__name__)


def worker_context(deps: Deps, *, envelope_sha: str, tolerated_fatal: int, participants_source: str) -> dict[str, Any]:
    """Configuration every worker of a run must share; recorded with each unit result and compared at report time."""
    return {
        "identity": deps.identity.describe(),
        "envelope_sha256": envelope_sha,
        "max_unit_rows": deps.max_unit_rows,
        "tolerated_fatal": tolerated_fatal,
        "participants_source": participants_source,
    }


class _Heartbeat:
    def __init__(self, store: LeaseStore, unit_id: str, token: str, ttl: timedelta) -> None:
        self._stop = threading.Event()
        self.lost = False
        self._thread = threading.Thread(target=self._run, args=(store, unit_id, token, ttl), daemon=True)

    def _run(self, store: LeaseStore, unit_id: str, token: str, ttl: timedelta) -> None:
        while not self._stop.wait(ttl.total_seconds() / 3):
            try:
                store.renew(unit_id, token, ttl)
            except LeaseLost:
                self.lost = True
                return
            except Exception:  # noqa: BLE001 - a transient renewal error must not kill the unit
                log.exception("lease renewal for %s failed", unit_id)

    def __enter__(self) -> _Heartbeat:
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join()


def work_with_leases(
    units: dict[str, Unit],
    deps: Deps,
    store: LeaseStore,
    *,
    owner: str,
    context: dict[str, Any],
    ttl: timedelta,
    max_attempts: int,
    process: Callable[[Unit, Deps], UnitResult] = process_unit,
) -> tuple[int, int]:
    """Claim and process units until none is claimable. Returns (units completed, attempts failed) by this worker."""
    completed = failed = 0
    prefer: str | None = None
    while True:
        lease = store.claim(owner, ttl, max_attempts, prefer)
        if lease is None:
            return completed, failed
        assert lease.token is not None
        unit = units[lease.unit_id]
        prefer = unit.uid
        try:
            with _Heartbeat(store, lease.unit_id, lease.token, ttl) as beat:
                result = process(unit, deps)
            if beat.lost:
                log.warning("lost the lease on %s while working; its result is discarded", unit.unit_id)
                continue
            store.complete(lease.unit_id, lease.token, {"context": context, "result": result.model_dump(mode="json")})
            completed += 1
            log.info("%s done: rows_in=%d rows_out=%d", unit.unit_id, result.rows_in, result.rows_out)
        except LeaseLost:
            log.warning("lost the lease on %s; another worker owns it now", unit.unit_id)
        except Exception as exc:  # noqa: BLE001 - recorded on the lease, retried up to max_attempts
            log.exception("unit %s failed", unit.unit_id)
            failed += 1
            with contextlib.suppress(LeaseLost):
                store.fail(lease.unit_id, lease.token, f"{type(exc).__name__}: {exc}", max_attempts)


def assemble_report(
    run_id: str,
    units: list[Unit],
    outcomes: dict[str, UnitResult | str],
    context: dict[str, Any],
    *,
    planned_units: int | None,
    filtered: bool,
    seconds: float,
) -> tuple[RunReport, dict[str, dict]]:
    """outcomes maps unit ids to a result or an error message; units without an outcome count as not done."""
    totals = UnitResult()
    per_type: dict[str, UnitResult] = {}
    unit_results: dict[str, dict] = {}
    done = failed = 0
    for unit in units:
        outcome = outcomes.get(unit.unit_id)
        if outcome is None:
            continue
        if isinstance(outcome, str):
            failed += 1
            unit_results[unit.unit_id] = {"error": outcome}
            continue
        done += 1
        unit_results[unit.unit_id] = outcome.model_dump()
        totals.merge(outcome)
        per_type.setdefault(unit.sample_type, UnitResult()).merge(outcome)
    report = RunReport(
        run_id=run_id,
        units_total=len(units),
        planned_units=planned_units,
        filtered=filtered,
        tolerated_fatal=int(context.get("tolerated_fatal", 0)),
        max_unit_rows=int(context.get("max_unit_rows", 0)),
        envelope_sha256=str(context.get("envelope_sha256", "")),
        identity=dict(context.get("identity") or {}),
        participants_source=str(context.get("participants_source", "")),
        units_done=done,
        units_failed=failed,
        rows_out=totals.rows_out,
        totals=totals,
        per_sample_type=per_type,
        seconds=seconds,
    )
    return report, unit_results


def report_from_leases(
    run_id: str, units: list[Unit], store: LeaseStore, *, planned_units: int
) -> tuple[RunReport, dict[str, dict]]:
    """The run report from the lease store. Every manifest unit must be seeded; all completed units must share one
    worker context, otherwise the run mixed configurations and cannot be reported."""
    leases = {lease.unit_id: lease for lease in store.all()}
    missing = [u.unit_id for u in units if u.unit_id not in leases]
    if missing:
        raise ValueError(f"{len(missing)} manifest units were never seeded, e.g. {missing[:3]}")
    outcomes: dict[str, UnitResult | str] = {}
    contexts: list[dict[str, Any]] = []
    seconds = 0.0
    for unit in units:
        lease = leases[unit.unit_id]
        if lease.state == DONE and lease.result:
            result = UnitResult.model_validate(lease.result["result"])
            outcomes[unit.unit_id] = result
            contexts.append(lease.result["context"])
            seconds += result.seconds
        elif lease.state == FAILED:
            outcomes[unit.unit_id] = "; ".join(lease.errors) or "failed"
    distinct = {repr(sorted(c.items())) for c in contexts}
    if len(distinct) > 1:
        raise ValueError("workers of this run used different configurations (identity, envelope, caps or tolerance)")
    context = contexts[0] if contexts else {}
    return assemble_report(
        run_id, units, outcomes, context, planned_units=planned_units, filtered=False, seconds=seconds
    )
