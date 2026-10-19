# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""CSV deletion lists -> retracted source-output identities for one unit; Grove retractions are read in run/unit."""

from __future__ import annotations

from dataclasses import dataclass

from mhc_export.identity.grove_ids import HealthKitIdentity, IdentityError
from mhc_export.transform.specs import TypeSpec


@dataclass(frozen=True)
class Tombstone:
    sample_type: str
    native_uuid: str
    timestamp: float | None


def tombstones_from_csv(rows: list[dict[str, str]]) -> tuple[list[Tombstone], int]:
    """Returns (tombstones, malformed rows). A row without sample type or id is unusable, not ignorable."""
    out: list[Tombstone] = []
    malformed = 0
    for row in rows:
        sample_type = (row.get("sampleType") or "").strip()
        uuid = (row.get("sampleId") or "").strip()
        if not sample_type or not uuid:
            malformed += 1
            continue
        ts_text = (row.get("timestamp") or "").strip()
        try:
            ts: float | None = float(ts_text) if ts_text else None
        except ValueError:
            ts = None
        out.append(Tombstone(sample_type, uuid, ts))
    return out, malformed


def tombstone_ids(tombstones: list[Tombstone], spec: TypeSpec, identity: HealthKitIdentity) -> tuple[set[str], int]:
    """Returns (source-output ids for this unit's sample type, number of unparseable rows)."""
    ids: set[str] = set()
    bad = 0
    for stone in tombstones:
        if stone.sample_type != spec.sample_type:
            continue
        try:
            ids.add(identity.source_output(spec.sample_type, stone.native_uuid, spec.measurement_id or ""))
        except IdentityError:
            bad += 1
    return ids, bad
