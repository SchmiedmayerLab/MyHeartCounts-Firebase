# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""process_unit: one user x one sample type, sources -> staged Parquet parts."""

from __future__ import annotations

import io
import json
import logging
import sys
import time
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from resource import RUSAGE_SELF, getrusage
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from mhc_export.config import IdentityConfig
from mhc_export.grove.view import parse_observation
from mhc_export.identity.participants import ParticipantLookup
from mhc_export.io.blobstore import BlobStore
from mhc_export.io.codec import CodecError, decode, decode_csv
from mhc_export.run.inputs import LEDGER_DIR
from mhc_export.run.models import Unit, UnitResult, UploadKind
from mhc_export.transform.dedup import dedup, dedup_conflicts, tuple_collisions
from mhc_export.transform.project import ProjectContext, ProjectError, project
from mhc_export.transform.specs import Registry
from mhc_export.transform.tombstones import Tombstone, retraction_targets, tombstone_ids, tombstones_from_csv
from mhc_export.transform.writer import RowBuffer, split_by_month, staging_uri, to_parquet_bytes

log = logging.getLogger(__name__)


@dataclass
class Deps:
    store: BlobStore
    registry: Registry
    identity: IdentityConfig
    participants: ParticipantLookup
    staging_prefix: str
    run_id: str
    max_unit_rows: int = 5_000_000
    tolerate_unreadable: bool = False


def _expand(resource: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Grove exchange Bundles carry Observations as entries; everything else is one resource."""
    if resource.get("resourceType") == "Bundle":
        for entry in resource.get("entry") or []:
            inner = (entry or {}).get("resource")
            if isinstance(inner, dict) and inner.get("resourceType") in ("Observation", "DocumentReference"):
                yield inner
        return
    yield resource


# Grove conformance failures signal a misconfigured key or a broken producer, never an expected exclusion.
FATAL_REASONS = frozenset(
    {
        "foreign_identity",
        "duplicate_grove_identity",
        "missing_grove_identity",
        "bad_grove_identity",
        "bad_writer_version",
    }
)


class UnitTooLarge(RuntimeError):
    pass


def process_unit(unit: Unit, deps: Deps) -> UnitResult:
    started = time.monotonic()
    result = UnitResult(objects=len(unit.objects), bytes_in=sum(o.size for o in unit.objects))
    spec = deps.registry.get(unit.sample_type)
    if spec is None:
        result.skipped_reason = "unknown_type"
        return result
    if not spec.exportable:
        result.skipped_reason = f"{spec.status}:{spec.value_kind}"
        return result

    participant_id = deps.participants.get_or_create(unit.uid)
    identity = deps.identity.for_participant(participant_id)
    drops: Counter[str] = Counter()
    warnings: Counter[str] = Counter()
    fatal: Counter[str] = Counter()
    rows = RowBuffer(spec.arrow_schema)
    tombstones: list[Tombstone] = []
    retracted: set[str] = set()
    seq = 0

    def take(resource: dict[str, Any], ctx: ProjectContext) -> None:
        nonlocal seq
        result.rows_in += 1
        try:
            projected = project(parse_observation(resource), spec, ctx, seq)
        except ProjectError as exc:
            if exc.reason in FATAL_REASONS:
                _fatal(deps, fatal, exc.reason, f"{unit.unit_id}: {exc}")
            else:
                drops[exc.reason] += 1
            return
        seq += 1
        rows.append(projected.row)
        if rows.count > deps.max_unit_rows:
            raise UnitTooLarge(
                f"unit {unit.unit_id} passed the cap of {deps.max_unit_rows} rows; "
                "raise --max-unit-rows or split the unit"
            )
        for warning in projected.warnings:
            warnings[warning] += 1

    for obj in unit.objects:
        try:
            blob = deps.store.read(obj.uri, obj.generation)
        except Exception as exc:  # noqa: BLE001 - any read failure fails the unit
            raise RuntimeError(f"read failed for {obj.uri}: {exc}") from exc
        if obj.upload_kind == UploadKind.DELETIONS:
            try:
                stones, malformed = tombstones_from_csv(decode_csv(blob))
            except CodecError as exc:
                _fatal(deps, fatal, "unreadable_deletions", f"{obj.uri}@{obj.generation}: {exc}")
                continue
            tombstones.extend(stones)
            if malformed:
                _fatal(deps, fatal, "malformed_deletion_row", f"{obj.uri}: {malformed} rows", count=malformed)
            continue
        try:
            resources = decode(blob)
        except CodecError as exc:
            _fatal(deps, fatal, "unreadable_object", f"{obj.uri}@{obj.generation}: {exc}")
            continue
        del blob
        ctx = ProjectContext(participant_id, identity, deps.run_id, obj.upload_kind, True, config=deps.identity)
        for outer in resources:
            if outer.get("resourceType") == "Bundle" and _is_retraction(outer):
                retracted |= retraction_targets(outer)
                continue
            for resource in _expand(outer):
                take(resource, ctx)

    table = rows.to_table()  # releases the buffered chunks
    result.arrow_mb = int(pa.total_allocated_bytes() / (1024 * 1024))
    result.dedup_conflicts = dedup_conflicts(table)
    table, result.dedup_removed = dedup(table)

    ids, bad_tombstones = tombstone_ids(tombstones, spec, identity)
    ids |= retracted
    result.tombstones_seen = len(ids)
    if bad_tombstones:
        drops["bad_tombstone_uuid"] += bad_tombstones
    if ids and table.num_rows:
        hit = pc.is_in(table["sample_id"], value_set=pa.array(sorted(ids), pa.string()))
        result.tombstoned = int(pc.sum(hit).as_py() or 0)
        table = table.filter(pc.invert(hit))

    result.tuple_collisions = tuple_collisions(table)
    months = list(split_by_month(table))
    planned = [staging_uri(deps.staging_prefix, unit.sample_type, y, m, unit.unit_id) for y, m, _ in months]
    ledger_uri = ledger_part_uri(deps.staging_prefix, unit)
    previous = _begin_unit_sidecar(deps, unit, [*planned, ledger_uri] if ids else planned)
    for uri, (_, _, part) in zip(planned, months, strict=True):
        deps.store.write(uri, to_parquet_bytes(part, extra_metadata={"export_run_id": deps.run_id}), overwrite=True)
        result.parts.append(uri)
    if ids:
        deps.store.write(ledger_uri, _ledger_bytes(ids, participant_id, unit.sample_type, deps.run_id), overwrite=True)
    _finish_unit_sidecar(deps, unit, previous, [*planned, ledger_uri] if ids else planned)
    result.rows_out = table.num_rows
    result.drops = dict(drops)
    result.warnings = dict(warnings)
    result.fatal = dict(fatal)
    result.seconds = time.monotonic() - started
    result.peak_rss_mb = _peak_rss_mb()
    return result


def _peak_rss_mb() -> int:
    """Process high-water mark, not the unit's own footprint; arrow_mb carries the per-unit Arrow allocation."""
    rss = getrusage(RUSAGE_SELF).ru_maxrss
    return int(rss / (1024 * 1024 if sys.platform == "darwin" else 1024))


def _fatal(deps: Deps, fatal: Counter[str], reason: str, detail: str, count: int = 1) -> None:
    """Corrupt or unusable planned input fails the unit unless the operator tolerates it explicitly."""
    if not deps.tolerate_unreadable:
        raise RuntimeError(f"{reason}: {detail}")
    log.warning("tolerated %s: %s", reason, detail)
    fatal[reason] += count


LEDGER_SCHEMA = pa.schema(
    [
        pa.field("sample_id", pa.string(), nullable=False),
        pa.field("participant_id", pa.string(), nullable=False),
        pa.field("sample_type", pa.string(), nullable=False),
        pa.field("run_id", pa.string(), nullable=False),
    ]
)


def ledger_part_uri(staging_prefix: str, unit: Unit) -> str:
    """Every retraction a unit saw, matched or not: later runs apply it to committed data and to replays."""
    return f"{staging_prefix.rstrip('/')}/{LEDGER_DIR}/{unit.sample_type}/{unit.unit_id.replace(':', '__')}.parquet"


def _ledger_bytes(ids: set[str], participant_id: str, sample_type: str, run_id: str) -> bytes:
    ordered = sorted(ids)
    n = len(ordered)
    table = pa.Table.from_pydict(
        {
            "sample_id": ordered,
            "participant_id": [participant_id] * n,
            "sample_type": [sample_type] * n,
            "run_id": [run_id] * n,
        },
        schema=LEDGER_SCHEMA,
    )
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd")
    return buf.getvalue()


def unit_sidecar_uri(staging_prefix: str, unit: Unit) -> str:
    return f"{staging_prefix.rstrip('/')}/_units/{unit.unit_id.replace(':', '__')}.json"


def _read_sidecar(deps: Deps, uri: str) -> list[str]:
    if not deps.store.exists(uri):
        return []
    try:
        return list(json.loads(deps.store.read(uri).decode()).get("parts", []))
    except (ValueError, OSError):
        return []


def _begin_unit_sidecar(deps: Deps, unit: Unit, planned: list[str]) -> list[str]:
    """Intent log: before any part is written, the sidecar names every part that may exist afterwards,
    so an attempt that dies mid-write leaves nothing a later redo cannot find and remove."""
    uri = unit_sidecar_uri(deps.staging_prefix, unit)
    previous = _read_sidecar(deps, uri)
    union = sorted(set(previous) | set(planned))
    deps.store.write(uri, json.dumps({"unit_id": unit.unit_id, "parts": union}).encode(), overwrite=True)
    return previous


def _finish_unit_sidecar(deps: Deps, unit: Unit, previous: list[str], planned: list[str]) -> None:
    for stale in set(previous) - set(planned):
        deps.store.delete(stale)
    uri = unit_sidecar_uri(deps.staging_prefix, unit)
    deps.store.write(uri, json.dumps({"unit_id": unit.unit_id, "parts": planned}).encode(), overwrite=True)


def _is_retraction(bundle: dict[str, Any]) -> bool:
    for entry in bundle.get("entry") or []:
        resource = (entry or {}).get("resource") or {}
        if resource.get("resourceType") == "Provenance":
            for activity in [resource.get("activity") or {}]:
                for coding in activity.get("coding") or []:
                    if coding.get("code") == "source-record-retracted":
                        return True
    return False
