# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Promote: compacted files -> v1/ in the datalake, snapshot listing, watermark. Idempotent on redo.

Only anonymized artifacts cross into the lake: Parquet files, the validation report, a sanitized run summary.
"""

from __future__ import annotations

import contextlib
import json
import logging
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from mhc_export.io.blobstore import BlobExistsError, BlobStore
from mhc_export.run.compact import list_compacted
from mhc_export.run.validate import compacted_fingerprint, report_digest, run_complete_check

log = logging.getLogger(__name__)

LAYOUT_VERSION = "v1"
SUMMARY_FIELDS = ("run_id", "units_total", "units_done", "units_failed", "rows_out", "seconds")
COUNTER_FIELDS = (
    "objects",
    "bytes_in",
    "rows_in",
    "rows_out",
    "drops",
    "warnings",
    "dedup_removed",
    "tombstones_seen",
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
    snapshot_uri: str = ""
    snapshot_written: bool = False
    watermark_uri: str = ""
    watermark_updated: bool = False
    seconds: float = 0.0


def _join(prefix: str, *parts: str) -> str:
    base = prefix.rstrip("/")
    tail = "/".join(parts)
    return f"{base}/{tail}" if base else tail


def sanitize_report(run_report: dict) -> dict[str, Any]:
    """Counts only: no unit ids (they embed the Firebase uid), no staging part names."""
    summary = run_report.get("report") or {}
    counters = lambda r: {k: r.get(k) for k in COUNTER_FIELDS if k in r}  # noqa: E731
    return {
        "report": {k: summary.get(k) for k in SUMMARY_FIELDS},
        "totals": counters(summary.get("totals") or {}),
        "per_sample_type": {t: counters(r) for t, r in (summary.get("per_sample_type") or {}).items()},
        "skipped_types": sorted(
            {u.split(":", 1)[1] for u, r in (run_report.get("units") or {}).items() if r.get("skipped_reason")}
        ),
    }


def _same_object(lake: BlobStore, dst: str, path: Path, size: int) -> bool:
    existing = lake.info(dst)
    if existing is None or existing.size != size:
        return False
    remote_md5 = lake.md5(dst)
    if remote_md5 is None:
        return True
    return remote_md5 == _local_md5(path)


def _local_md5(path: Path) -> str:
    import hashlib

    digest = hashlib.md5()  # noqa: S324 - integrity only, mirrors the GCS object checksum
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def promote_run(
    compacted_root: Path,
    lake: BlobStore,
    lake_prefix: str,
    *,
    run_id: str,
    batch_end: datetime | None,
    validation: dict,
    run_report: dict,
) -> PromoteResult:
    """lake_prefix is 'gs://bucket/path' or '' for a local store rooted at the lake directory."""
    started = time.monotonic()
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
    completeness = run_complete_check(run_report, run_id)
    if not completeness.ok:
        raise PromoteConflict(f"run is not complete: {completeness.detail}")
    lake_validation_uri = _join(lake_prefix, "runs", run_id, "validation.json")
    if lake.exists(lake_validation_uri):
        recorded = json.loads(lake.read(lake_validation_uri).decode())
        if recorded.get("compacted_digest") != digest:
            raise PromoteConflict("this run id was already promoted with a different file set; use a new run id")

    result = PromoteResult(run_id=run_id)
    for sample_type, year, month, files in list_compacted(compacted_root):
        for n, path in enumerate(sorted(files)):
            dst = _join(
                lake_prefix,
                LAYOUT_VERSION,
                sample_type,
                f"year={year:04d}",
                f"month={month:02d}",
                f"part-{run_id}-{n:05d}.parquet",
            )
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
            result.bytes += size
            result.files.append(dst)

    result.snapshot_uri = _join(lake_prefix, "runs", run_id, "snapshot.jsonl")
    if lake.exists(result.snapshot_uri):
        log.info("snapshot %s already exists; keeping the original citation", result.snapshot_uri)
    else:
        listing = sorted(lake.list(_join(lake_prefix, LAYOUT_VERSION) + "/"), key=lambda i: i.uri)
        lines = [json.dumps({"uri": i.uri, "size": i.size, "generation": i.generation}) for i in listing]
        try:
            lake.write(result.snapshot_uri, ("\n".join(lines) + "\n").encode(), overwrite=False)
            result.snapshot_written = True
        except BlobExistsError:
            log.info("snapshot %s written concurrently; keeping it", result.snapshot_uri)
    _write_if_absent(lake, lake_validation_uri, json.dumps(validation, indent=1, default=str))
    summary_uri = _join(lake_prefix, "runs", run_id, "summary.json")
    _write_if_absent(lake, summary_uri, json.dumps(sanitize_report(run_report), indent=1))

    result.watermark_uri = _join(lake_prefix, "runs", "_watermark.json")
    result.watermark_updated = _advance_watermark(
        lake, result.watermark_uri, run_id, batch_end, len(result.files), result.snapshot_uri
    )
    result.seconds = time.monotonic() - started
    log.info(
        "promoted %s: %d copied, %d already present, %.1f MB, watermark %s",
        run_id,
        result.copied,
        result.skipped,
        result.bytes / 1e6,
        "advanced" if result.watermark_updated else "unchanged",
    )
    return result


def _write_if_absent(lake: BlobStore, uri: str, text: str) -> None:
    if lake.exists(uri):
        return
    with contextlib.suppress(BlobExistsError):
        lake.write(uri, text.encode(), overwrite=False)


def _advance_watermark(
    lake: BlobStore, uri: str, run_id: str, batch_end: datetime | None, files: int, snapshot_uri: str
) -> bool:
    """Monotonic: never moves backwards, never replaced by a run without a batch end."""
    if batch_end is None:
        log.info("no batch end given; watermark left unchanged")
        return False
    existing: dict[str, Any] = {}
    if lake.exists(uri):
        existing = json.loads(lake.read(uri).decode())
    current = existing.get("batch_end")
    if current and datetime.fromisoformat(current) > batch_end:
        log.warning("watermark %s is ahead of %s; not regressing it", current, batch_end.isoformat())
        return False
    if current and datetime.fromisoformat(current) == batch_end and existing.get("run_id") == run_id:
        return False
    watermark = {
        "run_id": run_id,
        "batch_end": batch_end.isoformat(),
        "promoted_at": datetime.now(tz=UTC).isoformat(timespec="seconds"),
        "files": files,
        "snapshot": snapshot_uri,
    }
    lake.write(uri, json.dumps(watermark, indent=1).encode(), overwrite=True)
    return True
