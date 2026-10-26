# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class Layout(StrEnum):
    LEGACY = "legacy"  # users/{uid}/{liveHealthSamples|historicalHealthSamples|healthDeletions}/{type}_{uuid}
    V1 = "v1"  # {uid}/{yyyy}/{mm}/{sampleType}/{batchUuid}


class UploadKind(StrEnum):
    HISTORICAL = "historical"
    LIVE = "live"
    DELETIONS = "deletions"


class DataVersion(StrEnum):
    PRE_GROVE = "pre-grove"
    GROVE_V1 = "grove-v1"


class Phase(StrEnum):
    PLANNING = "planning"
    PROCESSING = "processing"
    COMPACTING = "compacting"
    VALIDATING = "validating"
    PROMOTING = "promoting"
    DONE = "done"
    FAILED = "failed"


class LeaseState(StrEnum):
    PENDING = "pending"
    LEASED = "leased"
    DONE = "done"
    FAILED = "failed"


class SourceObject(BaseModel):
    uri: str
    generation: int | None = None
    size: int
    layout: Layout
    upload_kind: UploadKind
    data_version: DataVersion = DataVersion.PRE_GROVE
    created: datetime | None = None


class Unit(BaseModel):
    unit_id: str
    uid: str
    sample_type: str
    objects: list[SourceObject] = Field(default_factory=list)
    expected_bytes: int = 0

    @staticmethod
    def make_id(uid: str, sample_type: str, shard: int | None = None) -> str:
        return f"{uid}:{sample_type}" if shard is None else f"{uid}:{sample_type}:{shard:03d}"


class Run(BaseModel):
    run_id: str
    batch_start: datetime | None
    batch_end: datetime
    phase: Phase = Phase.PLANNING
    grove_package_version: str
    key_id: str
    key_epoch: int
    created_at: datetime


class UnitResult(BaseModel):
    objects: int = 0
    bytes_in: int = 0
    rows_in: int = 0
    rows_out: int = 0
    drops: dict[str, int] = Field(default_factory=dict)
    warnings: dict[str, int] = Field(default_factory=dict)
    fatal: dict[str, int] = Field(default_factory=dict)
    dedup_removed: int = 0
    dedup_conflicts: int = 0
    tombstones_seen: int = 0
    grove_retractions: int = 0
    tombstoned: int = 0
    tuple_collisions: int = 0
    parts: list[str] = Field(default_factory=list)
    skipped_reason: str | None = None
    seconds: float = 0.0
    peak_rss_mb: int = 0
    arrow_mb: int = 0

    def merge(self, other: UnitResult) -> None:
        self.objects += other.objects
        self.bytes_in += other.bytes_in
        self.rows_in += other.rows_in
        self.rows_out += other.rows_out
        for key, value in other.drops.items():
            self.drops[key] = self.drops.get(key, 0) + value
        for key, value in other.warnings.items():
            self.warnings[key] = self.warnings.get(key, 0) + value
        for key, value in other.fatal.items():
            self.fatal[key] = self.fatal.get(key, 0) + value
        self.dedup_removed += other.dedup_removed
        self.dedup_conflicts += other.dedup_conflicts
        self.tombstones_seen += other.tombstones_seen
        self.grove_retractions += other.grove_retractions
        self.tombstoned += other.tombstoned
        self.tuple_collisions += other.tuple_collisions
        self.parts += other.parts
        self.seconds += other.seconds
        self.peak_rss_mb = max(self.peak_rss_mb, other.peak_rss_mb)
        self.arrow_mb = max(self.arrow_mb, other.arrow_mb)


class Lease(BaseModel):
    state: LeaseState = LeaseState.PENDING
    owner: str | None = None
    lease_expires_at: datetime | None = None
    heartbeat_at: datetime | None = None
    attempts: int = 0
    result: UnitResult | None = None
    error: str | None = None


class RunReport(BaseModel):
    run_id: str
    units_total: int
    planned_units: int | None = None
    filtered: bool = False
    tolerated_fatal: int = 0
    max_unit_rows: int = 0
    envelope_sha256: str = ""
    identity: dict[str, object] = Field(default_factory=dict)
    grove: dict[str, object] = Field(default_factory=dict)
    participants_source: str = ""
    units_done: int
    units_failed: int
    rows_out: int
    totals: UnitResult
    per_sample_type: dict[str, UnitResult]
    seconds: float
