# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""process_unit: one user x one sample type, sources -> staged Parquet parts."""

from __future__ import annotations

import logging
import time
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc

from mhc_export.config import IdentityConfig
from mhc_export.grove.view import parse_observation
from mhc_export.identity.participants import ParticipantLookup
from mhc_export.io.blobstore import BlobStore
from mhc_export.io.codec import CodecError, decode, decode_csv
from mhc_export.run.models import Unit, UnitResult, UploadKind
from mhc_export.sources.firestore import ObservationSource
from mhc_export.transform.dedup import dedup, tuple_collisions
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
    firestore: ObservationSource | None = None


def _expand(resource: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """Grove exchange Bundles carry Observations as entries; everything else is one resource."""
    if resource.get("resourceType") == "Bundle":
        for entry in resource.get("entry") or []:
            inner = (entry or {}).get("resource")
            if isinstance(inner, dict) and inner.get("resourceType") in ("Observation", "DocumentReference"):
                yield inner
        return
    yield resource


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
    rows = RowBuffer(spec.arrow_schema)
    tombstones: list[Tombstone] = []
    retracted: set[str] = set()
    seq = 0

    for obj in unit.objects:
        try:
            blob = deps.store.read(obj.uri, obj.generation)
        except Exception as exc:  # noqa: BLE001 - any read failure fails the unit
            raise RuntimeError(f"read failed for {obj.uri}: {exc}") from exc
        if obj.upload_kind == UploadKind.DELETIONS:
            try:
                tombstones.extend(tombstones_from_csv(decode_csv(blob)))
            except CodecError as exc:
                log.warning("unreadable deletion file %s: %s", obj.uri, exc)
                drops["unreadable_deletions"] += 1
            continue
        try:
            resources = decode(blob)
        except CodecError as exc:
            log.warning("unreadable object %s: %s", obj.uri, exc)
            drops["unreadable_object"] += 1
            continue
        ctx = ProjectContext(participant_id, identity, deps.run_id, obj.upload_kind, from_archive=True)
        for outer in resources:
            if outer.get("resourceType") == "Bundle" and _is_retraction(outer):
                retracted |= retraction_targets(outer)
                continue
            for resource in _expand(outer):
                result.rows_in += 1
                try:
                    projected = project(parse_observation(resource), spec, ctx, seq)
                except ProjectError as exc:
                    drops[exc.reason] += 1
                    continue
                seq += 1
                rows.append(projected.row)
                for warning in projected.warnings:
                    warnings[warning] += 1

    if unit.firestore_collection and deps.firestore is not None:
        ctx = ProjectContext(participant_id, identity, deps.run_id, UploadKind.LIVE, from_archive=False)
        for resource in deps.firestore.observations(unit.uid, unit.sample_type):
            result.rows_in += 1
            try:
                projected = project(parse_observation(resource), spec, ctx, seq)
            except ProjectError as exc:
                drops[exc.reason] += 1
                continue
            seq += 1
            rows.append(projected.row)
            for warning in projected.warnings:
                warnings[warning] += 1

    table = rows.to_table()
    del rows
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
    for year, month, part in split_by_month(table):
        uri = staging_uri(deps.staging_prefix, unit.sample_type, year, month, unit.unit_id)
        deps.store.write(uri, to_parquet_bytes(part, extra_metadata={"export_run_id": deps.run_id}), overwrite=True)
        result.parts.append(uri)
    result.rows_out = table.num_rows
    result.drops = dict(drops)
    result.warnings = dict(warnings)
    result.seconds = time.monotonic() - started
    return result


def _is_retraction(bundle: dict[str, Any]) -> bool:
    for entry in bundle.get("entry") or []:
        resource = (entry or {}).get("resource") or {}
        if resource.get("resourceType") == "Provenance":
            for activity in [resource.get("activity") or {}]:
                for coding in activity.get("coding") or []:
                    if coding.get("code") == "source-record-retracted":
                        return True
    return False
