# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""The committed state of a lake.

A lake is a set of immutable Parquet files plus, per committed run, a dataset manifest listing exactly the files
that make up the dataset after that run. One pointer object, `_current.json`, names the committed manifest; it is
replaced with a compare-and-swap, so readers always see one complete version. Files that a later run replaced stay
in the bucket until garbage collection but are no longer part of any current dataset.
"""

from __future__ import annotations

import hashlib
from datetime import datetime

from pydantic import BaseModel

from mhc_export.io.blobstore import BlobConflict, BlobStore

CURRENT_NAME = "_current.json"
LAYOUT_VERSION = "v1"


class LakeConflict(RuntimeError):
    pass


class DatasetEntry(BaseModel):
    path: str  # relative to the lake prefix
    sample_type: str
    year: int
    month: int
    bytes: int
    rows: int
    md5: str
    participant_min: str | None = None
    participant_max: str | None = None
    run_id: str

    @property
    def partition(self) -> tuple[str, int, int]:
        return self.sample_type, self.year, self.month


class CurrentPointer(BaseModel):
    run_id: str
    batch_end: datetime | None
    dataset: str  # relative path of the dataset manifest
    dataset_sha256: str
    files: int
    rows: int
    committed_at: datetime
    previous_dataset: str | None = None
    source: str | None = None  # what the committed run's plan listed


def join(prefix: str, *parts: str) -> str:
    base = prefix.rstrip("/")
    tail = "/".join(parts)
    return f"{base}/{tail}" if base else tail


def dataset_path(run_id: str) -> str:
    return f"runs/{run_id}/dataset.jsonl"


def dump_dataset(entries: list[DatasetEntry]) -> bytes:
    ordered = sorted(entries, key=lambda e: e.path)
    return "".join(e.model_dump_json() + "\n" for e in ordered).encode()


def load_dataset(data: bytes) -> list[DatasetEntry]:
    return [DatasetEntry.model_validate_json(line) for line in data.decode().splitlines() if line.strip()]


def read_current(lake: BlobStore, prefix: str) -> tuple[CurrentPointer | None, str | None]:
    found = lake.read_versioned(join(prefix, CURRENT_NAME))
    if found is None:
        return None, None
    data, token = found
    return CurrentPointer.model_validate_json(data), token


def read_committed(lake: BlobStore, prefix: str) -> tuple[CurrentPointer | None, str | None, list[DatasetEntry]]:
    """The current pointer, its version token, and the dataset it names (verified against its digest)."""
    pointer, token = read_current(lake, prefix)
    if pointer is None:
        return None, None, []
    data = lake.read(join(prefix, pointer.dataset))
    if hashlib.sha256(data).hexdigest() != pointer.dataset_sha256:
        raise LakeConflict(f"dataset manifest {pointer.dataset} does not match the committed digest")
    return pointer, token, load_dataset(data)


def commit(lake: BlobStore, prefix: str, pointer: CurrentPointer, token: str | None) -> None:
    try:
        lake.write_versioned(join(prefix, CURRENT_NAME), pointer.model_dump_json(indent=1).encode(), token)
    except BlobConflict as exc:
        stored, _ = read_current(lake, prefix)
        if stored == pointer:
            return  # a retried write that had already landed
        raise LakeConflict("another run committed to this lake concurrently; nothing was published") from exc
