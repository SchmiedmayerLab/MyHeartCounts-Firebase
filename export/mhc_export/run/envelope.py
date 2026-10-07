# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""The run envelope: what a run covers, fixed at plan time and verified by every later phase.

It lives next to the manifest in the private state location and is never copied into the lake.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

ENVELOPE_NAME = "run.json"


class Eligibility(BaseModel):
    source: Literal["firestore", "file", "unchecked"]
    excluded_users: dict[str, int] = Field(default_factory=dict)
    excluded_units: int = 0


class RunEnvelope(BaseModel):
    run_id: str
    batch_start: datetime | None
    batch_end: datetime | None
    window_applied: bool
    scoped: bool
    scope_uid_count: int | None = None
    scope_sample_types: list[str] | None = None
    source: str
    manifest_sha256: str
    unit_count: int
    eligibility: Eligibility
    grove_version: str
    registry_commit: str
    package_version: str
    created_at: datetime


def manifest_sha256(manifest_bytes: bytes) -> str:
    return hashlib.sha256(manifest_bytes).hexdigest()


def envelope_digest(envelope: RunEnvelope | dict[str, Any]) -> str:
    data = envelope.model_dump(mode="json") if isinstance(envelope, RunEnvelope) else envelope
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()


def envelope_uri_for(manifest_uri: str) -> str:
    """run.json sits next to manifest.jsonl."""
    base, _, _ = manifest_uri.rpartition("/")
    return f"{base}/{ENVELOPE_NAME}" if base else ENVELOPE_NAME


def promotion_problems(envelope: RunEnvelope, *, production_lake: bool) -> list[str]:
    """Reasons a run may not become part of a lake. A production lake also needs a real window and eligibility."""
    problems: list[str] = []
    if envelope.scoped:
        problems.append("scoped runs (participant or type filters) never promote")
    if production_lake:
        if not envelope.window_applied:
            problems.append("the batch window was not applied at plan time")
        if envelope.eligibility.source == "unchecked":
            problems.append("eligibility was not checked at plan time")
        if envelope.batch_end is None:
            problems.append("the run has no batch end")
    return problems


def contiguity_problem(envelope: RunEnvelope, watermark: dict[str, Any] | None) -> str | None:
    """A run starts exactly where the last committed run ended; a redo of the committed run is allowed."""
    if watermark is None:
        if envelope.batch_start is not None:
            return f"no run was committed yet, but the run starts at {envelope.batch_start.isoformat()}"
        return None
    if watermark.get("run_id") == envelope.run_id:
        return None
    committed_end = watermark.get("batch_end")
    start = envelope.batch_start.isoformat() if envelope.batch_start else None
    if committed_end is None and start is None:
        return None  # unbounded local runs
    if committed_end is None or start is None or datetime.fromisoformat(committed_end) != envelope.batch_start:
        return f"the run starts at {start}, but the last committed run ended at {committed_end}"
    return None
