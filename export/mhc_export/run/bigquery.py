# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Load the committed lake dataset into native BigQuery tables.

One table per sample type, partitioned by month of effective_start and clustered by participant_id. Only files
listed in the committed dataset manifest are loaded. Each month partition is replaced by one load job with an
explicit file list and WRITE_TRUNCATE on the partition decorator, so a retry or a re-run can never append twice;
job ids are derived from the destination partition and its file list, and a job that already succeeded is not
repeated. The dataset a destination holds is recorded in the lake under bigquery/{project}.{dataset}.json only
after every load and delete succeeded, so the next load diffs against what the warehouse holds, not against the
lake's previous version. Partitions present in the warehouse but absent from the lake are deleted.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import pyarrow as pa

from mhc_export.io.blobstore import BlobStore
from mhc_export.run.lake import CurrentPointer, DatasetEntry, dataset_path, join, load_dataset, read_committed
from mhc_export.transform.specs import default_registry

log = logging.getLogger(__name__)

TABLE_RE = re.compile(r"[^A-Za-z0-9_]")
JOB_RE = re.compile(r"[^A-Za-z0-9_-]")
Partition = tuple[str, int, int]


def table_name(sample_type: str) -> str:
    return TABLE_RE.sub("_", sample_type).lower()


def partition_decorator(year: int, month: int) -> str:
    return f"{year:04d}{month:02d}"


def job_id(destination: str, uris: list[str], nonce: str = "") -> str:
    """Deterministic per destination partition and exact file list; lake files are immutable and named per run, so
    an id seen before means that exact content was already loaded into that exact partition."""
    digest = hashlib.sha256("\n".join([destination, nonce, *sorted(uris)]).encode()).hexdigest()[:24]
    table, _, decorator = destination.rpartition("$")
    return JOB_RE.sub("_", f"mhc_load_{table.rsplit('.', 1)[-1]}_{decorator}_{digest}")


def marker_path(lake_prefix: str, project: str, dataset: str) -> str:
    return join(lake_prefix, "bigquery", f"{project}.{dataset}.json")


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


def _warehouse_partitions(client: Any, project: str, dataset: str) -> set[Partition]:
    """Month partitions of every sample-type table the destination dataset holds."""
    by_table = {table_name(t): t for t in default_registry().exportable_types()}
    found: set[Partition] = set()
    for table in client.list_tables(f"{project}.{dataset}"):
        sample_type = by_table.get(table.table_id)
        if sample_type is None:
            continue
        for pid in client.list_partitions(f"{project}.{dataset}.{table.table_id}"):
            if len(pid) == 6 and pid.isdigit():
                found.add((sample_type, int(pid[:4]), int(pid[4:])))
            else:
                raise ValueError(f"{table_name(sample_type)} holds partition {pid!r}, which the lake never produces")
    return found


def load_committed(
    lake: BlobStore,
    lake_prefix: str,
    project: str,
    dataset: str,
    *,
    full: bool = False,
    client: Any = None,
    nonce: str = "",
) -> dict[str, Any]:
    """Bring the warehouse to the lake's committed dataset. Returns the load record it also writes per run."""
    if not lake_prefix.startswith("gs://"):
        raise ValueError("BigQuery loads read gs:// files; promote to a gs:// lake first")
    pointer, _, current = read_committed(lake, lake_prefix)
    if pointer is None:
        raise ValueError("the lake has no committed dataset")
    if client is None:
        from google.cloud import bigquery

        client = bigquery.Client(project=project)
    marker_uri = marker_path(lake_prefix, project, dataset)
    marker = json.loads(lake.read(marker_uri)) if lake.exists(marker_uri) else None
    baseline: list[DatasetEntry] = []
    if marker and not full:
        baseline = load_dataset(lake.read(join(lake_prefix, dataset_path(marker["run_id"]))))
    plan = plan_loads(lake_prefix, pointer, current, baseline, full=full or marker is None)
    wanted = {e.partition for e in current}
    plan.deletes = sorted(_warehouse_partitions(client, project, dataset) - wanted)
    record: dict[str, Any] = {
        "run_id": pointer.run_id,
        "dataset_sha256": pointer.dataset_sha256,
        "destination": f"{project}.{dataset}",
        "baseline_run_id": marker["run_id"] if marker and not full else None,
        "loads": {},
        "deletes": [],
    }
    for (sample_type, year, month), uris in plan.loads.items():
        table_id = f"{project}.{dataset}.{table_name(sample_type)}"
        _ensure_table(client, table_id, sample_type)
        destination = f"{table_id}${partition_decorator(year, month)}"
        used = _run_job(
            client,
            job_id(destination, uris, nonce),
            lambda jid, u=uris, d=destination: client.load_table_from_uri(u, d, job_config=_load_config(), job_id=jid),
        )
        record["loads"][destination] = {"job_id": used, "files": len(uris)}
        log.info("loaded %s from %d files (%s)", destination, len(uris), used)
    for sample_type, year, month in plan.deletes:
        destination = f"{project}.{dataset}.{table_name(sample_type)}${partition_decorator(year, month)}"
        client.delete_table(destination, not_found_ok=True)
        record["deletes"].append(destination)
        log.info("deleted %s", destination)
    payload = json.dumps(record, indent=1).encode()
    lake.write(join(lake_prefix, "runs", pointer.run_id, f"bigquery-{project}.{dataset}.json"), payload, overwrite=True)
    lake.write(marker_uri, payload, overwrite=True)
    return record


def _load_config() -> Any:
    from google.cloud import bigquery

    return bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.PARQUET,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        create_disposition=bigquery.CreateDisposition.CREATE_NEVER,
    )
