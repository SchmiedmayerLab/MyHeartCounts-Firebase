# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Load the committed lake dataset into native BigQuery tables.

One table per sample type, partitioned by month of effective_start and clustered by participant_id. Only files
listed in the committed dataset manifest are loaded, always with WRITE_TRUNCATE, so a retry can never append twice.
A table that is missing, reloaded in full, or mostly changed is replaced by one job over all its files, which readers
see as one swap; other changes replace single month partitions. Jobs run concurrently, a few per table. Their ids
derive from the destination, the table instance and the files, so an id seen before means that exact content already
landed in that exact table. The dataset a destination holds is recorded in the lake under
bigquery/{project}.{dataset}.json, written with a compare-and-swap only after every load and delete succeeded, so the
next load diffs against what the warehouse holds. Partitions present in the warehouse but absent from the lake are
deleted.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import re
import threading
import time
import uuid
from collections import defaultdict, deque
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pyarrow as pa

from mhc_export.io.blobstore import BlobConflict, BlobStore, widen_pool
from mhc_export.run.lake import CurrentPointer, DatasetEntry, dataset_path, join, load_dataset, read_committed
from mhc_export.transform.specs import default_registry

log = logging.getLogger(__name__)

TABLE_RE = re.compile(r"[^A-Za-z0-9_]")
JOB_RE = re.compile(r"[^A-Za-z0-9_-]")
Partition = tuple[str, int, int]

RETRYABLE = frozenset(
    {
        "rateLimitExceeded",
        "backendError",
        "internalError",
        "jobRateLimitExceeded",
        "jobBackendError",
        "jobInternalError",
    }
)
MAX_JOB_URIS = 10_000
MAX_TABLE_BYTES = 4 * 10**12
WHOLE_TABLE_SHARE = 0.25
WHOLE_TABLE_JOBS = 50
ATTEMPTS = 5


class LoadFailed(RuntimeError):
    pass


def table_name(sample_type: str) -> str:
    return TABLE_RE.sub("_", sample_type).lower()


def partition_decorator(year: int, month: int) -> str:
    return f"{year:04d}{month:02d}"


def job_id(destination: str, uris: list[str], salt: str = "") -> str:
    """Deterministic per destination, salt (table instance, --full nonce) and exact file list."""
    digest = hashlib.sha256("\n".join([destination, salt, *sorted(uris)]).encode()).hexdigest()[:24]
    table, _, decorator = destination.partition("$")
    return JOB_RE.sub("_", f"mhc_load_{table.rsplit('.', 1)[-1]}_{decorator or 'all'}_{digest}")


def marker_path(lake_prefix: str, project: str, dataset: str) -> str:
    return join(lake_prefix, "bigquery", f"{project}.{dataset}.json")


def lock_path(lake_prefix: str, project: str, dataset: str) -> str:
    return join(lake_prefix, "bigquery", f"{project}.{dataset}.lock")


LEASE_TTL = timedelta(minutes=30)
LEASE_RENEW_SECONDS = 300.0


class _DestinationLease:
    """One bq-load per destination at a time, so a slower run's jobs cannot land after a newer run's marker. The
    lease is renewed while the load runs and released only by its owner."""

    def __init__(
        self, lake: BlobStore, uri: str, ttl: timedelta = LEASE_TTL, renew_seconds: float = LEASE_RENEW_SECONDS
    ) -> None:
        self._lake = lake
        self._uri = uri
        self._ttl = ttl
        self._renew_seconds = renew_seconds
        self._owner = uuid.uuid4().hex
        self._started = ""
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.lost = False

    def _document(self) -> bytes:
        expires = (datetime.now(UTC) + self._ttl).isoformat()
        return json.dumps({"owner": self._owner, "started_at": self._started, "expires_at": expires}).encode()

    def __enter__(self) -> _DestinationLease:
        now = datetime.now(UTC)
        found = self._lake.read_versioned(self._uri)
        if found is not None:
            held = json.loads(found[0])
            if datetime.fromisoformat(held["expires_at"]) > now:
                raise LoadFailed(
                    f"another bq-load holds {self._uri} until {held['expires_at']} (started {held['started_at']}); "
                    "wait for it, or delete the lock if that run is gone"
                )
        self._started = now.isoformat()
        try:
            self._lake.write_versioned(self._uri, self._document(), found[1] if found else None)
        except BlobConflict as exc:
            raise LoadFailed(f"another bq-load took {self._uri} just now") from exc
        self._thread = threading.Thread(target=self._renew, name="bq-lease", daemon=True)
        self._thread.start()
        return self

    def _renew(self) -> None:
        while not self._stop.wait(self._renew_seconds):
            try:
                found = self._lake.read_versioned(self._uri)
                if found is None or json.loads(found[0]).get("owner") != self._owner:
                    self.lost = True
                    return
                self._lake.write_versioned(self._uri, self._document(), found[1])
            except BlobConflict:
                self.lost = True
                return
            except Exception:  # noqa: BLE001 - a transient renewal error must not end the load
                log.exception("renewing %s failed", self._uri)

    def check(self) -> None:
        if self.lost:
            raise LoadFailed(f"this bq-load lost {self._uri} to another one; reload with --full")

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        found = self._lake.read_versioned(self._uri)
        if found is not None and json.loads(found[0]).get("owner") == self._owner:
            self._lake.delete(self._uri)


@dataclass
class LoadPlan:
    run_id: str
    loads: dict[Partition, list[str]] = field(default_factory=dict)  # partition -> gs:// file URIs


def plan_loads(
    lake_prefix: str, pointer: CurrentPointer, current: list[DatasetEntry], previous: list[DatasetEntry], *, full: bool
) -> LoadPlan:
    """Partitions whose file set changed since the previous dataset, or all of them."""
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
    return plan


@dataclass
class LoadJob:
    sample_type: str
    table_id: str
    destination: str  # the table, or table$YYYYMM for one partition
    uris: list[str]
    absent: bool = False  # the warehouse lacks (some of) this content now, so an earlier success proves nothing

    @property
    def whole_table(self) -> bool:
        return "$" not in self.destination


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


def _spec(sample_type: str) -> Any:
    spec = default_registry().get(sample_type)
    if spec is None:
        raise ValueError(f"unknown sample type {sample_type}")
    return spec


def _ensure_table(client: Any, table_id: str, sample_type: str) -> Any:
    """The table, created empty with the type's schema, partitioning and clustering if it is missing."""
    from google.api_core.exceptions import NotFound
    from google.cloud import bigquery

    try:
        return client.get_table(table_id)
    except NotFound:
        pass
    table = bigquery.Table(table_id, schema=bigquery_schema(_spec(sample_type).arrow_schema))
    table.time_partitioning = bigquery.TimePartitioning(
        type_=bigquery.TimePartitioningType.MONTH, field="effective_start"
    )
    table.clustering_fields = ["participant_id"]
    return client.create_table(table, exists_ok=True)


def _partition_config() -> Any:
    from google.cloud import bigquery

    return bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.PARQUET,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        create_disposition=bigquery.CreateDisposition.CREATE_NEVER,
    )


def _table_config() -> Any:
    """Replaces every row but keeps the table definition, including descriptions and policy tags set on it."""
    from google.cloud import bigquery

    return bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.PARQUET,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE_DATA,
        create_disposition=bigquery.CreateDisposition.CREATE_NEVER,
    )


def _check_table(client: Any, table_id: str, sample_type: str) -> None:
    table = client.get_table(table_id)
    partitioning = table.time_partitioning
    names = [f.name for f in table.schema]
    if (
        partitioning is None
        or partitioning.field != "effective_start"
        or str(partitioning.type_) != "MONTH"
        or list(table.clustering_fields or []) != ["participant_id"]
        or names != _spec(sample_type).arrow_schema.names
    ):
        raise LoadFailed(f"{table_id} lost its partitioning, clustering or schema after a whole-table load")


def _reason(exc: BaseException) -> str | None:
    errors = getattr(exc, "errors", None) or []
    first = errors[0] if errors else None
    return first.get("reason") if isinstance(first, dict) else None


def _get_job(client: Any, jid: str, location: str | None) -> Any:
    """A job right after a Conflict on its id; the lookup may briefly answer NotFound."""
    from google.api_core import exceptions as gexc
    from google.api_core.retry import Retry, if_exception_type

    retry = Retry(
        predicate=if_exception_type(gexc.NotFound, gexc.TooManyRequests, gexc.ServiceUnavailable),
        timeout=180,
    )
    return client.get_job(jid, location=location, retry=retry)


def _run_job(
    client: Any,
    jid: str,
    start: Callable[[str], Any],
    *,
    location: str | None,
    invocation: str,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Run a load under a deterministic id. A Conflict reuses a successful or running job with that id and moves past
    a failed one. Transient failures are retried under ids unique to this invocation, so an earlier run's failures
    never block a later one."""
    from google.api_core.exceptions import Conflict, GoogleAPICallError

    ids = [jid] + [f"{jid}_r{invocation}_{n}" for n in range(1, ATTEMPTS)]
    for n, attempt_id in enumerate(ids):
        try:
            job = start(attempt_id)
        except Conflict:
            job = _get_job(client, attempt_id, location)
            if job.state == "DONE":
                if job.error_result is None:
                    return attempt_id
                continue  # an earlier attempt failed under this id; try again under this invocation's own id
        try:
            if job.state == "DONE" and job.error_result is not None:
                reason = job.error_result.get("reason")
                message = job.error_result.get("message", "")
            else:
                job.result()
                return attempt_id
        except GoogleAPICallError as exc:
            reason, message = _reason(exc), str(exc)
        if reason not in RETRYABLE:
            raise LoadFailed(f"load {attempt_id} failed ({reason}): {message}")
        if n < len(ids) - 1:
            log.warning("load %s failed with %s; retrying", attempt_id, reason)
            sleep(min(60.0, 2.0**n) + random.random())
    raise LoadFailed(f"load {jid} failed on all {ATTEMPTS} attempts")


def _warehouse_partitions(
    client: Any, project: str, dataset: str, concurrency: int = 8
) -> tuple[set[str], set[Partition]]:
    """Sample types with a table in the destination, and the month partitions those tables hold."""
    by_table = {table_name(t): t for t in default_registry().exportable_types()}
    tables = [t.table_id for t in client.list_tables(f"{project}.{dataset}") if t.table_id in by_table]
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="bq-list") as pool:
        listed = list(pool.map(lambda t: client.list_partitions(f"{project}.{dataset}.{t}"), tables))
    found: set[Partition] = set()
    for table_id, pids in zip(tables, listed, strict=True):
        for pid in pids:
            if not (len(pid) == 6 and pid.isdigit()):
                raise ValueError(f"{table_id} holds partition {pid!r}, which the lake never produces")
            found.add((by_table[table_id], int(pid[:4]), int(pid[4:])))
    return {by_table[t] for t in tables}, found


def _await_running_loads(client: Any, project: str, dataset: str) -> None:
    """Jobs of an earlier, interrupted bq-load keep queueing and running server-side; let them land before planning.
    Only this principal's jobs are visible."""
    from google.api_core.exceptions import Forbidden

    try:
        jobs = [*client.list_jobs(project=project, state_filter="pending")]
        jobs += [*client.list_jobs(project=project, state_filter="running")]
    except Forbidden:
        log.warning("cannot list jobs (bigquery.jobs.list): loads of an interrupted bq-load are not awaited")
        return
    for job in jobs:
        destination = getattr(job, "destination", None)
        if not str(getattr(job, "job_id", "")).startswith("mhc_load_") or destination is None:
            continue
        if destination.project != project or destination.dataset_id != dataset:
            continue
        log.info("waiting for running load %s", job.job_id)
        try:
            job.result()
        except Exception:  # noqa: BLE001 - its outcome is re-planned from warehouse state
            log.warning("earlier load %s failed", job.job_id)


def _plan_jobs(
    client: Any,
    project: str,
    dataset: str,
    lake_prefix: str,
    current: list[DatasetEntry],
    plan: LoadPlan,
    *,
    full: bool,
    concurrency: int = 8,
) -> tuple[list[LoadJob], list[Partition]]:
    existing_types, held = _warehouse_partitions(client, project, dataset, concurrency)
    entries_by_type: dict[str, list[DatasetEntry]] = defaultdict(list)
    for entry in current:
        entries_by_type[entry.sample_type].append(entry)
    changed_by_type: dict[str, list[Partition]] = defaultdict(list)
    for partition in plan.loads:
        changed_by_type[partition[0]].append(partition)
    jobs: list[LoadJob] = []
    whole_types: set[str] = set()
    for sample_type, entries in sorted(entries_by_type.items()):
        table_id = f"{project}.{dataset}.{table_name(sample_type)}"
        partitions = {e.partition for e in entries}
        missing = sample_type not in existing_types or not partitions & held
        # a month the warehouse lacks is changed whatever the marker says, e.g. after a reload that never landed
        changed = sorted(set(changed_by_type.get(sample_type, [])) | (partitions - held))
        if not (missing or changed):
            continue
        mostly_changed = len(changed) >= WHOLE_TABLE_SHARE * len(partitions) or len(changed) > WHOLE_TABLE_JOBS
        fits = len(entries) <= MAX_JOB_URIS and sum(e.bytes for e in entries) <= MAX_TABLE_BYTES
        if (missing or full or mostly_changed) and fits:
            uris = sorted(join(lake_prefix, e.path) for e in entries)
            jobs.append(LoadJob(sample_type, table_id, table_id, uris, absent=bool(partitions - held)))
            whole_types.add(sample_type)
            continue
        loads = sorted(partitions) if missing else sorted(changed)
        for _, year, month in loads:
            uris = plan.loads.get((sample_type, year, month)) or sorted(
                join(lake_prefix, e.path) for e in entries if e.partition == (sample_type, year, month)
            )
            destination = f"{table_id}${partition_decorator(year, month)}"
            absent = (sample_type, year, month) not in held
            jobs.append(LoadJob(sample_type, table_id, destination, uris, absent=absent))
    wanted = {e.partition for e in current}
    deletes = sorted(p for p in held - wanted if p[0] not in whole_types)
    return jobs, deletes


def _dispatch(
    jobs: list[LoadJob],
    run: Callable[[LoadJob], str],
    *,
    concurrency: int,
    max_per_table: int,
) -> tuple[dict[str, str], list[str]]:
    """Run jobs round-robin across tables, at most max_per_table at once per table. The first failure stops new
    submissions; jobs already running are awaited. Returns (destination -> job id, errors)."""
    queues: dict[str, deque[LoadJob]] = defaultdict(deque)
    for job in jobs:
        queues[job.table_id].append(job)
    order = deque(sorted(queues))
    inflight: dict[str, int] = defaultdict(int)
    running: dict[Future[str], LoadJob] = {}
    done: dict[str, str] = {}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="bq-load") as pool:
        while running or (order and not errors):
            idle = 0
            while order and not errors and len(running) < concurrency and idle < len(order):
                table = order[0]
                order.rotate(-1)
                if inflight[table] >= max_per_table:
                    idle += 1
                    continue
                idle = 0
                job = queues[table].popleft()
                if not queues[table]:
                    order.remove(table)
                inflight[table] += 1
                running[pool.submit(run, job)] = job
            if not running:
                break
            finished, _ = wait(running, return_when=FIRST_COMPLETED)
            for future in finished:
                job = running.pop(future)
                inflight[job.table_id] -= 1
                try:
                    done[job.destination] = future.result()
                except Exception as exc:  # noqa: BLE001 - collected and raised after in-flight jobs end
                    errors.append(f"{job.destination}: {exc}")
    if not errors and len(done) != len(jobs):
        raise LoadFailed(f"only {len(done)} of {len(jobs)} loads were run")
    return done, errors


def load_committed(
    lake: BlobStore,
    lake_prefix: str,
    project: str,
    dataset: str,
    *,
    full: bool = False,
    client: Any = None,
    nonce: str = "",
    concurrency: int = 8,
    max_per_table: int = 2,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Bring the warehouse to the lake's committed dataset. Returns the load record it also writes per run."""
    if not lake_prefix.startswith("gs://"):
        raise ValueError("BigQuery loads read gs:// files; promote to a gs:// lake first")
    if concurrency < 1 or max_per_table < 1:
        raise ValueError("concurrency and max_per_table must be at least 1")
    pointer, _, current = read_committed(lake, lake_prefix)
    if pointer is None:
        raise ValueError("the lake has no committed dataset")
    if client is None:
        from google.cloud import bigquery

        client = bigquery.Client(project=project)
        widen_pool(client._http, concurrency + 4)
    location = client.get_dataset(f"{project}.{dataset}").location
    with _DestinationLease(lake, lock_path(lake_prefix, project, dataset)) as lease:
        _await_running_loads(client, project, dataset)
        return _load(
            lease,
            lake,
            lake_prefix,
            project,
            dataset,
            client,
            location,
            pointer,
            current,
            full,
            nonce,
            concurrency,
            max_per_table,
            sleep,
        )


def _load(
    lease: _DestinationLease,
    lake: BlobStore,
    lake_prefix: str,
    project: str,
    dataset: str,
    client: Any,
    location: str | None,
    pointer: CurrentPointer,
    current: list[DatasetEntry],
    full: bool,
    nonce: str,
    concurrency: int,
    max_per_table: int,
    sleep: Callable[[float], None],
) -> dict[str, Any]:
    marker_uri = marker_path(lake_prefix, project, dataset)
    found = lake.read_versioned(marker_uri)
    marker, token = (json.loads(found[0]), found[1]) if found else (None, None)
    baseline: list[DatasetEntry] = []
    if marker and not full:
        baseline = load_dataset(lake.read(join(lake_prefix, dataset_path(marker["run_id"]))))
    plan = plan_loads(lake_prefix, pointer, current, baseline, full=full or marker is None)
    jobs, deletes = _plan_jobs(client, project, dataset, lake_prefix, current, plan, full=full, concurrency=concurrency)

    instances: dict[str, str] = {}
    for table_id in sorted({j.table_id for j in jobs}):
        table = _ensure_table(client, table_id, next(j.sample_type for j in jobs if j.table_id == table_id))
        created = getattr(table, "created", None)
        instances[table_id] = created.isoformat() if isinstance(created, datetime) else str(created)
    invocation = uuid.uuid4().hex[:12]

    def run(job: LoadJob) -> str:
        config = _table_config() if job.whole_table else _partition_config()
        salt = f"{instances[job.table_id]}\n{nonce}" + (f"\nabsent {invocation}" if job.absent else "")
        return _run_job(
            client,
            job_id(job.destination, job.uris, salt),
            lambda jid: client.load_table_from_uri(
                job.uris, job.destination, job_config=config, job_id=jid, location=location
            ),
            location=location,
            invocation=invocation,
            sleep=sleep,
        )

    started = time.monotonic()
    done, errors = _dispatch(jobs, run, concurrency=concurrency, max_per_table=max_per_table)
    if errors:
        raise LoadFailed(f"{len(errors)} of {len(jobs)} loads failed; the marker is unchanged. First: {errors[0]}")
    for job in jobs:
        if job.whole_table:
            _check_table(client, job.table_id, job.sample_type)
    lease.check()
    destinations = [
        f"{project}.{dataset}.{table_name(sample_type)}${partition_decorator(year, month)}"
        for sample_type, year, month in deletes
    ]
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="bq-delete") as pool:
        list(pool.map(lambda d: client.delete_table(d, not_found_ok=True), destinations))
    deleted = sorted(destinations)
    record: dict[str, Any] = {
        "run_id": pointer.run_id,
        "dataset_sha256": pointer.dataset_sha256,
        "destination": f"{project}.{dataset}",
        "baseline_run_id": marker["run_id"] if marker and not full else None,
        "loads": {j.destination: {"job_id": done[j.destination], "files": len(j.uris)} for j in jobs},
        "whole_tables": sorted(j.table_id for j in jobs if j.whole_table),
        "deletes": deleted,
        "seconds": round(time.monotonic() - started, 1),
    }
    payload = json.dumps(record, indent=1).encode()
    lake.write(join(lake_prefix, "runs", pointer.run_id, f"bigquery-{project}.{dataset}.json"), payload, overwrite=True)
    lease.check()
    try:
        lake.write_versioned(marker_uri, payload, token)
    except BlobConflict as exc:
        stored = lake.read_versioned(marker_uri)
        if stored is not None and stored[0] == payload:
            return record  # a retried upload that had already landed
        raise LoadFailed(
            "the marker changed during this load, so another bq-load ran despite the lease; reload with --full"
        ) from exc
    return record
