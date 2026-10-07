# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Everything compaction and validation read, resolved to local files.

- staged parts of this run, under {state}/staging/{run}/{type}/year=/month=/
- this run's retraction ledger, under {state}/staging/{run}/_ledger/{type}/
- the committed ledger of earlier runs, under {state}/ledger/{type}/
- the committed lake files of every partition this run may change

Remote locations are copied into a work directory; local ones are read in place.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from mhc_export.io.blobstore import BlobStore, LocalBlobStore, sync_prefix
from mhc_export.run.lake import CurrentPointer, DatasetEntry, join, read_committed

log = logging.getLogger(__name__)

LEDGER_DIR = "_ledger"
Partition = tuple[str, int, int]


@dataclass
class RunInputs:
    staging_root: Path
    pointer: CurrentPointer | None
    committed_entries: list[DatasetEntry]
    committed: dict[Partition, list[Path]] = field(default_factory=dict)
    ledger: dict[str, list[Path]] = field(default_factory=dict)  # cumulative, per sample type
    fresh_ledger: dict[str, list[Path]] = field(default_factory=dict)  # this run only

    @property
    def base_dataset_sha256(self) -> str | None:
        return self.pointer.dataset_sha256 if self.pointer else None


def staging_ledger_prefix(staging_prefix: str) -> str:
    return join(staging_prefix, LEDGER_DIR)


def _local_files(root: Path) -> dict[str, list[Path]]:
    """{sample type: parquet files} under root/{type}/."""
    out: dict[str, list[Path]] = defaultdict(list)
    if root.is_dir():
        for type_dir in sorted(p for p in root.iterdir() if p.is_dir()):
            out[type_dir.name] = sorted(type_dir.glob("*.parquet"))
    return dict(out)


def staged_partitions(staging_root: Path) -> set[Partition]:
    out: set[Partition] = set()
    if not staging_root.is_dir():
        return out
    for path in staging_root.glob("*/year=*/month=*/*.parquet"):
        month_dir, year_dir, type_dir = path.parent, path.parent.parent, path.parent.parent.parent
        if type_dir.name.startswith("_"):
            continue
        out.add((type_dir.name, int(year_dir.name[5:]), int(month_dir.name[6:])))
    return out


def fresh_participants(fresh: dict[str, list[Path]]) -> dict[str, set[str]]:
    con = duckdb.connect()
    out: dict[str, set[str]] = {}
    for sample_type, files in fresh.items():
        if files:
            paths = "[" + ", ".join(f"'{p}'" for p in files) + "]"
            out[sample_type] = {
                r[0] for r in con.execute(f"select distinct participant_id from read_parquet({paths})").fetchall()
            }
    return out


def candidate_partitions(
    entries: list[DatasetEntry], staged: set[Partition], retracting: dict[str, set[str]]
) -> set[Partition]:
    """Partitions this run may change: everything it staged, plus every committed partition of a type with new
    retractions whose files cover a retracting participant (files are sorted by participant, so a file's
    participant range bounds where that participant's rows can be)."""
    out = set(staged)
    for entry in entries:
        participants = retracting.get(entry.sample_type)
        if not participants or entry.participant_min is None or entry.participant_max is None:
            continue
        if any(entry.participant_min <= p <= entry.participant_max for p in participants):
            out.add(entry.partition)
    return out


def gather_inputs(
    *,
    lake: BlobStore,
    lake_prefix: str,
    state: BlobStore,
    state_prefix: str,
    run_id: str,
    work_dir: Path,
) -> RunInputs:
    pointer, _, entries = read_committed(lake, lake_prefix)
    staging_uri = join(state_prefix, "staging", run_id)
    ledger_uri = join(state_prefix, "ledger")
    if isinstance(state, LocalBlobStore):
        staging_root = state.root / staging_uri
        committed_ledger_root = state.root / ledger_uri
    else:
        staging_root = work_dir / "staging" / run_id
        committed_ledger_root = work_dir / "ledger"
        sync_prefix(state, staging_uri, staging_root)
        sync_prefix(state, ledger_uri, committed_ledger_root)
    fresh = _local_files(staging_root / LEDGER_DIR)
    ledger = _local_files(committed_ledger_root)
    for sample_type, files in fresh.items():
        ledger[sample_type] = sorted({*ledger.get(sample_type, []), *files})
    wanted = candidate_partitions(entries, staged_partitions(staging_root), fresh_participants(fresh))
    committed: dict[Partition, list[Path]] = defaultdict(list)
    for entry in entries:
        if entry.partition not in wanted:
            continue
        if isinstance(lake, LocalBlobStore):
            local = lake.root / join(lake_prefix, entry.path)
        else:
            local = work_dir / "lake" / entry.path
            if not (local.is_file() and local.stat().st_size == entry.bytes):
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(lake.read(join(lake_prefix, entry.path)))
        committed[entry.partition].append(local)
    log.info(
        "inputs for %s: %d staged partitions, %d committed files in %d partitions, ledger for %d types",
        run_id,
        len(staged_partitions(staging_root)),
        sum(len(v) for v in committed.values()),
        len(committed),
        len(ledger),
    )
    return RunInputs(
        staging_root=staging_root,
        pointer=pointer,
        committed_entries=entries,
        committed=dict(committed),
        ledger=ledger,
        fresh_ledger=fresh,
    )


def commit_ledger(state: BlobStore, state_prefix: str, run_id: str) -> int:
    """Copy this run's staged ledger into the committed ledger before the lake pointer moves.

    Applying a retraction early is harmless (it is a fact from the source), so copying first means a crash between
    the two steps can never lose a retraction for later runs.
    """
    source = join(state_prefix, "staging", run_id, LEDGER_DIR) + "/"
    copied = 0
    for info in state.list(source):
        if source not in info.uri:
            continue
        name = info.uri[info.uri.index(source) + len(source) :]
        sample_type, _, unit_file = name.partition("/")
        if not unit_file.endswith(".parquet"):
            continue
        target = join(state_prefix, "ledger", sample_type, f"{run_id}__{unit_file}")
        if not state.exists(target):
            state.copy(info.uri, target, overwrite=False)
            copied += 1
    return copied
