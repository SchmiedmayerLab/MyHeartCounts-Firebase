# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Promote: publish a validated run as the lake's next dataset version, atomically.

The run's rebuilt partition files are uploaded under run-specific immutable names, a dataset manifest is written
that lists the committed files of untouched partitions plus the new files of rebuilt ones, and only then the lake
pointer is swapped to that manifest with a compare-and-swap. Readers see either the previous or the new dataset,
never a mix. Only anonymized artifacts cross into the lake: Parquet files, the validation report, a sanitized
summary and the dataset manifest.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from mhc_export.io.blobstore import BlobExistsError, BlobStore
from mhc_export.run.compact import MANIFEST_NAME, list_compacted, partition_key, read_touched
from mhc_export.run.envelope import RunEnvelope, contiguity_problem, envelope_digest, promotion_problems
from mhc_export.run.lake import (
    LAYOUT_VERSION,
    CurrentPointer,
    DatasetEntry,
    LakeConflict,
    commit,
    dataset_path,
    dump_dataset,
    join,
    read_committed,
)
from mhc_export.run.validate import compacted_fingerprint, file_md5, report_digest, run_complete_check

log = logging.getLogger(__name__)

SUMMARY_FIELDS = (
    "run_id",
    "units_total",
    "units_done",
    "units_failed",
    "rows_out",
    "seconds",
    "tolerated_fatal",
    "identity",
    "grove",
    "participants_source",
)
COUNTER_FIELDS = (
    "objects",
    "bytes_in",
    "rows_in",
    "rows_out",
    "drops",
    "warnings",
    "fatal",
    "dedup_removed",
    "dedup_conflicts",
    "tombstones_seen",
    "grove_retractions",
    "tombstoned",
    "tuple_collisions",
    "seconds",
)


class PromoteConflict(RuntimeError):
    pass


class PromoteResult(BaseModel):
    run_id: str
    copied: int = 0
    skipped: int = 0
    bytes: int = 0
    files: list[str] = Field(default_factory=list)
    replaced_partitions: int = 0
    dataset_uri: str = ""
    dataset_files: int = 0
    dataset_rows: int = 0
    committed: bool = False
    already_committed: bool = False
    seconds: float = 0.0


def sanitize_report(run_report: dict) -> dict[str, Any]:
    """Counts only: no unit ids (they embed the Firebase uid), no staging part names."""
    summary = run_report.get("report") or {}
    counters = lambda r: {k: r.get(k) for k in COUNTER_FIELDS if k in r}  # noqa: E731
    return {
        "report": {k: summary.get(k) for k in SUMMARY_FIELDS},
        "totals": counters(summary.get("totals") or {}),
        "per_sample_type": {t: counters(r) for t, r in (summary.get("per_sample_type") or {}).items()},
        "skipped_types": sorted(
            {u.split(":")[1] for u, r in (run_report.get("units") or {}).items() if r.get("skipped_reason")}
        ),
    }


def _same_object(lake: BlobStore, dst: str, path: Path, size: int) -> bool:
    existing = lake.info(dst)
    if existing is None or existing.size != size:
        return False
    remote_md5 = lake.md5(dst)
    if remote_md5 is None:
        return False
    return remote_md5 == _local_md5(path)


def _local_md5(path: Path) -> str:
    return file_md5(path)


BUCKET_ROOT = re.compile(r"gs://[a-z0-9][a-z0-9._-]*/?")


def production_run_problems(envelope: RunEnvelope, run_report: dict) -> list[str]:
    """What the workers and the plan recorded must match a production run; flags on one command are not enough."""
    summary = run_report.get("report") or {}
    identity = summary.get("identity") or {}
    grove = summary.get("grove") or {}
    problems: list[str] = []
    if identity.get("key_source") != "secret-manager":
        problems.append("the key did not come from Secret Manager")
    if identity.get("key_id") in (None, "", "local"):
        problems.append("the key id is missing or 'local'")
    if summary.get("participants_source") != "firestore":
        problems.append("participant ids did not come from the Firestore lookup")
    if grove.get("accept_legacy") is not False:
        problems.append("the workers read legacy resources or recorded no Grove settings")
    if envelope.eligibility.source != "firestore":
        problems.append("eligibility was not read from Firestore at plan time")
    if not BUCKET_ROOT.fullmatch(envelope.source):
        problems.append(f"the plan listed {envelope.source}, not a whole source bucket")
    if envelope.unit_count == 0:
        problems.append("an empty run never moves a production watermark")
    return problems


def _check_guards(
    compacted_root: Path,
    run_id: str,
    envelope: RunEnvelope,
    validation: dict,
    run_report: dict,
    production_lake: bool,
    production: bool = False,
) -> str:
    if not validation.get("ok"):
        raise PromoteConflict("validation did not pass; refusing to promote")
    if validation.get("run_id") != run_id:
        raise PromoteConflict(f"validation is for run {validation.get('run_id')!r}, not {run_id!r}")
    if (run_report.get("report") or {}).get("run_id") != run_id:
        raise PromoteConflict("run report is for a different run")
    digest, _ = compacted_fingerprint(compacted_root)
    if validation.get("compacted_digest") != digest:
        raise PromoteConflict("compacted files changed since validation; validate again")
    if validation.get("report_digest") != report_digest(run_report):
        raise PromoteConflict("run report changed since validation; validate again")
    if validation.get("envelope_sha256") != envelope_digest(envelope):
        raise PromoteConflict("validation was not run against this run envelope; validate again with --envelope")
    completeness = run_complete_check(run_report, run_id, envelope=envelope)
    if not completeness.ok:
        raise PromoteConflict(f"run is not complete: {completeness.detail}")
    problems = promotion_problems(envelope, production_lake=production_lake)
    if production:
        problems += production_run_problems(envelope, run_report)
    if problems:
        raise PromoteConflict("run may not be promoted: " + "; ".join(problems))
    return digest


def promote_run(
    compacted_root: Path,
    lake: BlobStore,
    lake_prefix: str,
    *,
    run_id: str,
    envelope: RunEnvelope,
    validation: dict,
    run_report: dict,
    production: bool = False,
) -> PromoteResult:
    """lake_prefix is 'gs://bucket/path' or '' for a local store rooted at the lake directory."""
    started = time.monotonic()
    production_lake = lake_prefix.startswith("gs://")
    if production and not production_lake:
        raise PromoteConflict("a production promotion needs a gs:// lake")
    _check_guards(compacted_root, run_id, envelope, validation, run_report, production_lake, production)
    result = PromoteResult(run_id=run_id, dataset_uri=join(lake_prefix, dataset_path(run_id)))
    pointer, token, committed = read_committed(lake, lake_prefix)
    if pointer is not None and pointer.run_id == run_id:
        result.already_committed = True
        result.dataset_files, result.dataset_rows = pointer.files, pointer.rows
        log.info("run %s is already the committed dataset; nothing to do", run_id)
        return result
    gap = contiguity_problem(envelope, pointer.model_dump(mode="json") if pointer else None)
    if gap:
        raise PromoteConflict(f"runs must be contiguous: {gap}")
    if production_lake and pointer is not None and pointer.source and pointer.source != envelope.source:
        raise PromoteConflict(f"the run listed {envelope.source}, but the lake was built from {pointer.source}")
    base = pointer.dataset_sha256 if pointer else None
    if validation.get("base_dataset_sha256") != base:
        raise PromoteConflict("the lake changed since this run was compacted and validated; compact and validate again")

    touched = read_touched(compacted_root)
    touched_keys = set(touched.get("partitions") or [])
    validated_md5 = {e["path"]: e.get("md5") for e in validation.get("entries") or []}
    ranges: dict[str, tuple[str | None, str | None]] = {}
    for manifest_path in compacted_root.glob(f"*/year=*/month=*/{MANIFEST_NAME}"):
        info = json.loads(manifest_path.read_text())
        prefix = info["key"]
        for f in info.get("files") or []:
            ranges[f"{prefix}/{f['name']}"] = (f.get("participant_min"), f.get("participant_max"))

    new_entries: list[DatasetEntry] = []
    for sample_type, year, month, files in list_compacted(compacted_root):
        for n, path in enumerate(sorted(files)):
            rel = f"{partition_key(sample_type, year, month)}/{path.name}"
            expected_md5 = validated_md5.get(rel)
            if not expected_md5:
                raise PromoteConflict(f"{rel} has no validated checksum; validate again")
            lake_rel = f"{LAYOUT_VERSION}/{sample_type}/year={year:04d}/month={month:02d}/part-{run_id}-{n:05d}.parquet"
            dst = join(lake_prefix, lake_rel)
            size = path.stat().st_size
            if lake.exists(dst):
                if not _same_object(lake, dst, path, size):
                    raise PromoteConflict(f"{dst} exists with different content")
                result.skipped += 1
            else:
                try:
                    lake.upload(path, dst, overwrite=False)
                    result.copied += 1
                except BlobExistsError:
                    if not _same_object(lake, dst, path, size):
                        raise PromoteConflict(f"{dst} appeared concurrently with different content") from None
                    result.skipped += 1
            uploaded_md5 = lake.md5(dst)
            if uploaded_md5 != expected_md5:
                raise PromoteConflict(f"{dst} content differs from the validated file (uploaded {uploaded_md5})")
            lo, hi = ranges.get(rel, (None, None))
            new_entries.append(
                DatasetEntry(
                    path=lake_rel,
                    sample_type=sample_type,
                    year=year,
                    month=month,
                    bytes=size,
                    rows=_rows(path),
                    md5=expected_md5,
                    participant_min=lo,
                    participant_max=hi,
                    run_id=run_id,
                )
            )
            result.bytes += size
            result.files.append(dst)

    kept = [e for e in committed if partition_key(*e.partition) not in touched_keys]
    result.replaced_partitions = len({partition_key(*e.partition) for e in committed} & touched_keys)
    dataset = kept + new_entries
    data = dump_dataset(dataset)
    _write_exact(lake, result.dataset_uri, data)
    _write_if_absent(
        lake, join(lake_prefix, "runs", run_id, "validation.json"), json.dumps(validation, indent=1, default=str)
    )
    _write_if_absent(
        lake, join(lake_prefix, "runs", run_id, "summary.json"), json.dumps(sanitize_report(run_report), indent=1)
    )

    new_pointer = CurrentPointer(
        run_id=run_id,
        batch_end=envelope.batch_end if envelope.batch_end is not None else (pointer.batch_end if pointer else None),
        dataset=dataset_path(run_id),
        dataset_sha256=hashlib.sha256(data).hexdigest(),
        files=len(dataset),
        rows=sum(e.rows for e in dataset),
        committed_at=datetime.now(tz=UTC),
        previous_dataset=pointer.dataset if pointer else None,
        source=envelope.source,
    )
    try:
        commit(lake, lake_prefix, new_pointer, token)
    except LakeConflict as exc:
        raise PromoteConflict(str(exc)) from exc
    result.committed = True
    result.dataset_files, result.dataset_rows = new_pointer.files, new_pointer.rows
    result.seconds = time.monotonic() - started
    log.info(
        "committed %s: %d files uploaded (%d already present), %d partitions replaced, dataset %d files %d rows",
        run_id,
        result.copied,
        result.skipped,
        result.replaced_partitions,
        result.dataset_files,
        result.dataset_rows,
    )
    return result


def _rows(path: Path) -> int:
    import pyarrow.parquet as pq

    return pq.read_metadata(path).num_rows


def _write_exact(lake: BlobStore, uri: str, data: bytes) -> None:
    """Write-once: an existing object must already hold exactly these bytes."""
    try:
        lake.write(uri, data, overwrite=False)
    except BlobExistsError:
        if lake.read(uri) != data:
            raise PromoteConflict(f"{uri} exists with different content; use a new run id") from None


def _write_if_absent(lake: BlobStore, uri: str, text: str) -> None:
    if lake.exists(uri):
        return
    with contextlib.suppress(BlobExistsError):
        lake.write(uri, text.encode(), overwrite=False)
