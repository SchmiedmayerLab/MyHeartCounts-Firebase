# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Load the committed lake dataset into native BigQuery tables.

One table per sample type, partitioned by month of effective_start and clustered by participant_id. Only files
listed in the committed dataset manifest are loaded. Each month partition is replaced by one load job with an
explicit file list and WRITE_TRUNCATE on the partition decorator, so a retry or a re-run can never append twice;
job ids are deterministic per (run, table, month), and a job that already succeeded is not repeated. Partitions a
run removed from the lake are deleted from the warehouse. The loaded state is recorded per run next to the run's
dataset manifest.
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import pyarrow as pa

from mhc_export.io.blobstore import BlobStore
from mhc_export.run.lake import CurrentPointer, DatasetEntry, join, load_dataset, read_committed
from mhc_export.transform.specs import default_registry

log = logging.getLogger(__name__)

TABLE_RE = re.compile(r"[^A-Za-z0-9_]")
JOB_RE = re.compile(r"[^A-Za-z0-9_-]")
Partition = tuple[str, int, int]


def table_name(sample_type: str) -> str:
    return TABLE_RE.sub("_", sample_type).lower()


def partition_decorator(year: int, month: int) -> str:
    return f"{year:04d}{month:02d}"


def job_id(run_id: str, sample_type: str, year: int, month: int, action: str = "load") -> str:
    return JOB_RE.sub("_", f"mhc_{action}_{run_id}_{table_name(sample_type)}_{partition_decorator(year, month)}")


@dataclass
class LoadPlan:
    run_id: str
    loads: dict[Partition, list[str]] = field(default_factory=dict)  # partition -> gs:// file URIs
    deletes: list[Partition] = field(default_factory=list)


def plan_loads(
    lake_prefix: str, pointer: CurrentPointer, current: list[DatasetEntry], previous: list[DatasetEntry], *, full: bool
) -> LoadPlan:
    """Partitions whose file set changed since the previous dataset (or all of them), and partitions that vanished."""
    plan = LoadPlan(run_id=pointer.run_id)
    by_partition: dict[Partition, list[DatasetEntry]] = defaultdict(list)
    for entry in current:
        by_partition[entry.partition].append(entry)
    previous_sets: dict[Partition, set[str]] = defaultdict(set)
    for entry in previous:
        previous_sets[entry.partition].add(entry.path)
    for partition, entries in sorted(by_partition.items()):
        paths = sorted(e.path for e in entries)
        if full or set(paths) != previous_sets.get(partition, set()):
            plan.loads[partition] = [join(lake_prefix, p) for p in paths]
    plan.deletes = sorted(set(previous_sets) - set(by_partition))
    return plan


def bigquery_schema(schema: pa.Schema) -> list[Any]:
    from google.cloud import bigquery

    kinds = {
        pa.string(): "STRING",
        pa.float64(): "FLOAT64",
        pa.int64(): "INT64",
        pa.bool_(): "BOOL",
        pa.timestamp("us", tz="UTC"): "TIMESTAMP",
    }
    return [bigquery.SchemaField(f.name, kinds[f.type], mode="NULLABLE" if f.nullable else "REQUIRED") for f in schema]


def _ensure_table(client: Any, table_id: str, sample_type: str) -> None:
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery

    try:
        client.get_table(table_id)
        return
    except NotFound:
        pass
    spec = default_registry().get(sample_type)
    if spec is None:
        raise ValueError(f"unknown sample type {sample_type}")
    table = bigquery.Table(table_id, schema=bigquery_schema(spec.arrow_schema))
    table.time_partitioning = bigquery.TimePartitioning(
        type_=bigquery.TimePartitioningType.MONTH, field="effective_start"
    )
    table.clustering_fields = ["participant_id"]
    client.create_table(table, exists_ok=True)


def _run_job(client: Any, jid: str, start: Any) -> str:
    """Start a job under a deterministic id; if that id already exists, reuse a success or retry once with a
    numbered suffix after a failure."""
    from google.api_core.exceptions import Conflict

    for attempt in range(5):
        attempt_id = jid if attempt == 0 else f"{jid}_retry{attempt}"
        try:
            job = start(attempt_id)
        except Conflict:
            job = client.get_job(attempt_id)
            if job.state == "DONE" and job.error_result is None:
                return attempt_id
            if job.state != "DONE":
                job.result()
                return attempt_id
            continue
        job.result()
        return attempt_id
    raise RuntimeError(f"job {jid} failed on every attempt")


def load_committed(
    lake: BlobStore, lake_prefix: str, project: str, dataset: str, *, full: bool = False
) -> dict[str, Any]:
    """Bring the warehouse to the lake's committed dataset. Returns the per-run load record it also writes."""
    from google.cloud import bigquery

    if not lake_prefix.startswith("gs://"):
        raise ValueError("BigQuery loads read gs:// files; promote to a gs:// lake first")
    pointer, _, current = read_committed(lake, lake_prefix)
    if pointer is None:
        raise ValueError("the lake has no committed dataset")
    previous = load_dataset(lake.read(join(lake_prefix, pointer.previous_dataset))) if pointer.previous_dataset else []
    plan = plan_loads(lake_prefix, pointer, current, [] if full else previous, full=full)
    client = bigquery.Client(project=project)
    record: dict[str, Any] = {
        "run_id": pointer.run_id,
        "dataset_sha256": pointer.dataset_sha256,
        "loads": {},
        "deletes": [],
    }
    for (sample_type, year, month), uris in plan.loads.items():
        table_id = f"{project}.{dataset}.{table_name(sample_type)}"
        _ensure_table(client, table_id, sample_type)
        destination = f"{table_id}${partition_decorator(year, month)}"
        config = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            create_disposition=bigquery.CreateDisposition.CREATE_NEVER,
        )
        used = _run_job(
            client,
            job_id(pointer.run_id, sample_type, year, month),
            lambda jid, u=uris, d=destination, c=config: client.load_table_from_uri(u, d, job_config=c, job_id=jid),
        )
        record["loads"][destination] = {"job_id": used, "files": len(uris)}
        log.info("loaded %s from %d files (%s)", destination, len(uris), used)
    for sample_type, year, month in plan.deletes:
        destination = f"{project}.{dataset}.{table_name(sample_type)}${partition_decorator(year, month)}"
        client.delete_table(destination, not_found_ok=True)
        record["deletes"].append(destination)
        log.info("deleted %s", destination)
    lake.write(
        join(lake_prefix, "runs", pointer.run_id, "bigquery.json"),
        json.dumps(record, indent=1).encode(),
        overwrite=True,
    )
    return record
