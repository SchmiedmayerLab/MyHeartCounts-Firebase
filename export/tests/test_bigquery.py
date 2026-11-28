# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
import threading
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import Conflict

from mhc_export.io.blobstore import LocalBlobStore
from mhc_export.run.bigquery import (
    LoadFailed,
    LoadJob,
    _dispatch,
    _run_job,
    bigquery_schema,
    job_id,
    load_committed,
    plan_loads,
    table_name,
)
from mhc_export.run.lake import CurrentPointer, DatasetEntry, commit, dataset_path, dump_dataset, read_current
from mhc_export.transform.specs import default_registry

HR = "HKQuantityTypeIdentifierHeartRate"


def entry(path: str, year: int, month: int, run_id: str, sample_type: str = HR) -> DatasetEntry:
    return DatasetEntry(
        path=path, sample_type=sample_type, year=year, month=month, bytes=1, rows=1, md5="0" * 32, run_id=run_id
    )


POINTER = CurrentPointer(
    run_id="r2",
    batch_end=None,
    dataset="runs/r2/dataset.jsonl",
    dataset_sha256="0" * 64,
    files=3,
    rows=3,
    committed_at=datetime(2026, 1, 1, tzinfo=UTC),
    previous_dataset="runs/r1/dataset.jsonl",
)


def test_plan_loads_only_changed_partitions() -> None:
    previous = [
        entry("v1/HR/year=2025/month=11/part-r1-00000.parquet", 2025, 11, "r1"),
        entry("v1/HR/year=2025/month=12/part-r1-00000.parquet", 2025, 12, "r1"),
        entry("v1/HR/year=2025/month=10/part-r1-00000.parquet", 2025, 10, "r1"),
    ]
    current = [
        entry("v1/HR/year=2025/month=11/part-r1-00000.parquet", 2025, 11, "r1"),  # unchanged
        entry("v1/HR/year=2025/month=12/part-r2-00000.parquet", 2025, 12, "r2"),  # replaced
        entry("v1/HR/year=2026/month=01/part-r2-00000.parquet", 2026, 1, "r2"),  # new
    ]
    plan = plan_loads("gs://lake", POINTER, current, previous, full=False)
    assert sorted(plan.loads) == [(HR, 2025, 12), (HR, 2026, 1)]
    assert plan.loads[(HR, 2025, 12)] == ["gs://lake/v1/HR/year=2025/month=12/part-r2-00000.parquet"]
    assert all(uri.count("*") == 0 for uris in plan.loads.values() for uri in uris)
    assert len(plan_loads("gs://lake", POINTER, current, previous, full=True).loads) == 3


def test_job_ids_depend_on_destination_and_files() -> None:
    dest = f"p.mhc_export.{table_name(HR)}$202512"
    jid = job_id(dest, ["gs://lake/a.parquet"])
    assert jid == job_id(dest, ["gs://lake/a.parquet"]) and jid.startswith(f"mhc_load_{table_name(HR)}_202512_")
    assert all(c.isalnum() or c in "_-" for c in jid) and len(jid) <= 1024
    assert jid != job_id(dest.replace("mhc_export", "other"), ["gs://lake/a.parquet"])
    assert jid != job_id(dest, ["gs://lake/b.parquet"]) and jid != job_id(dest, ["gs://lake/a.parquet"], "full")


@pytest.mark.parametrize("sample_type", default_registry().exportable_types())
def test_every_exportable_type_maps_to_a_bigquery_schema(sample_type: str) -> None:
    spec = default_registry().get(sample_type)
    fields = bigquery_schema(spec.arrow_schema)
    assert [f.name for f in fields] == spec.arrow_schema.names
    assert {f.field_type for f in fields} <= {"STRING", "FLOAT64", "INT64", "BOOL", "TIMESTAMP"}


class GsStore(LocalBlobStore):
    """A local directory addressed as gs://lake/..."""

    def _path(self, uri: str):
        return super()._path(uri.removeprefix("gs://lake/").removeprefix("gs://lake"))


def _failure(reason: str) -> Exception:
    from google.cloud.bigquery.job.base import _error_result_to_exception

    return _error_result_to_exception({"reason": reason, "message": reason})


class Warehouse:
    """Thread-safe in-memory stand-in for the BigQuery client calls the loader makes. A uri ending in
    /YYYYMM/<file> lands in that month."""

    def __init__(self, fail: dict[str, list[str]] | None = None) -> None:
        self.lock = threading.Lock()
        self.tables: dict[str, dict] = {}
        self.jobs: dict[str, SimpleNamespace] = {}
        self.started: list[str] = []
        self.fail = fail or {}  # destination -> reasons for successive attempts
        self.created = 0
        self.dispositions: dict[str, str] = {}

    def get_dataset(self, dataset: str):
        return SimpleNamespace(location="US")

    def list_jobs(self, **kw):
        return []

    def get_table(self, table_id: str):
        from google.api_core.exceptions import NotFound
        from google.cloud import bigquery

        with self.lock:
            if table_id not in self.tables:
                raise NotFound(table_id)
            t = self.tables[table_id]
            return SimpleNamespace(
                created=t["created"],
                time_partitioning=bigquery.TimePartitioning(type_="MONTH", field="effective_start"),
                clustering_fields=["participant_id"],
                schema=t["schema"],
            )

    def create_table(self, table, exists_ok: bool = False) -> None:
        with self.lock:
            self.created += 1
            key = f"{table.project}.{table.dataset_id}.{table.table_id}"
            self.tables.setdefault(key, {"created": self.created, "partitions": set(), "schema": table.schema})
        return self.get_table(key)

    def drop(self, table_id: str) -> None:
        del self.tables[table_id]

    def truncate(self, table_id: str) -> None:
        self.tables[table_id]["partitions"] = set()

    def list_tables(self, dataset: str):
        return [SimpleNamespace(table_id=t.rsplit(".", 1)[1]) for t in self.tables if t.startswith(dataset + ".")]

    def list_partitions(self, table_id: str) -> list[str]:
        return sorted(self.tables[table_id]["partitions"])

    def load_table_from_uri(self, uris, destination, job_config=None, job_id=None, location=None):
        assert location == "US"
        with self.lock:
            if job_id in self.jobs:
                raise Conflict(job_id)
            self.started.append(destination)
            self.dispositions[destination] = str(job_config.write_disposition) if job_config else ""
            reasons = self.fail.get(destination) or []
            reason = reasons.pop(0) if reasons else None
            if reason is None:
                table, _, decorator = destination.partition("$")
                months = {u.rsplit("/", 2)[1] for u in uris}
                if decorator:
                    assert months == {decorator}
                    self.tables[table]["partitions"].add(decorator)
                else:
                    self.tables[table]["partitions"] = months
            error = None if reason is None else {"reason": reason, "message": reason}
            self.jobs[job_id] = SimpleNamespace(state="DONE", error_result=error)

        def result():
            if reason is not None:
                raise _failure(reason)

        return SimpleNamespace(state="RUNNING", error_result=None, result=result)

    def get_job(self, jid: str, location=None, retry=None) -> SimpleNamespace:
        return self.jobs[jid]

    def delete_table(self, destination: str, not_found_ok: bool = False) -> None:
        table, _, decorator = destination.partition("$")
        with self.lock:
            self.tables.get(table, {"partitions": set()})["partitions"].discard(decorator)


def _entries(run_id: str, months: list[int], year: int = 2025) -> list[DatasetEntry]:
    return [entry(f"v1/HR/{year}{m:02d}/part-{run_id}-0.parquet", year, m, run_id) for m in months]


def _commit(store: GsStore, run_id: str, entries: list[DatasetEntry]) -> None:
    import hashlib

    data = dump_dataset(entries)
    store.write(f"gs://lake/{dataset_path(run_id)}", data, overwrite=True)
    previous, token = read_current(store, "gs://lake")
    pointer = CurrentPointer(
        run_id=run_id,
        batch_end=None,
        dataset=dataset_path(run_id),
        dataset_sha256=hashlib.sha256(data).hexdigest(),
        files=len(entries),
        rows=len(entries),
        committed_at=datetime(2026, 1, 1, tzinfo=UTC),
        previous_dataset=previous.dataset if previous else None,
    )
    commit(store, "gs://lake", pointer, token)


def _load(store, bq, dataset: str = "d", **kw):
    return load_committed(store, "gs://lake", "p", dataset, client=bq, sleep=lambda _: None, **kw)


TABLE = f"p.d.{table_name(HR)}"


def test_new_tables_load_whole_and_small_changes_load_per_partition(tmp_path) -> None:
    store = GsStore(tmp_path)
    bq = Warehouse()
    _commit(store, "r1", _entries("r1", list(range(1, 11))))
    first = _load(store, bq)
    assert first["whole_tables"] == [TABLE] and list(first["loads"]) == [TABLE]
    assert bq.tables[TABLE]["partitions"] == {f"2025{m:02d}" for m in range(1, 11)}
    # r2 rewrites March and empties April; the March load fails once with a non-retryable error
    r2 = [e for e in _entries("r1", list(range(1, 11))) if e.month not in (3, 4)] + _entries("r2", [3])
    _commit(store, "r2", r2)
    bq.fail = {f"{TABLE}$202503": ["invalid"]}
    with pytest.raises(LoadFailed, match="invalid"):
        _load(store, bq)
    assert "202504" in bq.tables[TABLE]["partitions"]  # nothing was deleted, the marker still names r1
    # the next run catches up from r1's state with one partition job and one delete
    _commit(store, "r3", r2)
    third = _load(store, bq)
    assert third["baseline_run_id"] == "r1" and list(third["loads"]) == [f"{TABLE}$202503"]
    assert third["deletes"] == [f"{TABLE}$202504"] and "202504" not in bq.tables[TABLE]["partitions"]
    again = _load(store, bq)
    assert again["loads"] == {} and again["deletes"] == []
    other = _load(store, bq, dataset="e")
    assert other["whole_tables"] == [f"p.e.{table_name(HR)}"]


def test_a_dropped_table_is_reloaded_even_though_the_marker_says_loaded(tmp_path) -> None:
    store = GsStore(tmp_path)
    bq = Warehouse()
    _commit(store, "r1", _entries("r1", [1, 2, 3]))
    first = _load(store, bq)
    bq.drop(TABLE)
    second = _load(store, bq)
    assert second["whole_tables"] == [TABLE] and bq.tables[TABLE]["partitions"] == {"202501", "202502", "202503"}
    assert second["loads"][TABLE]["job_id"] != first["loads"][TABLE]["job_id"]


def test_transient_failures_retry_under_fresh_ids_and_others_stop(tmp_path) -> None:
    store = GsStore(tmp_path)
    _commit(store, "r1", _entries("r1", [1, 2]))
    bq = Warehouse(fail={TABLE: ["backendError", "jobRateLimitExceeded"]})
    record = _load(store, bq)
    assert "_r" in record["loads"][TABLE]["job_id"] and bq.started.count(TABLE) == 3
    for reason in ("quotaExceeded", "timeout", "accessDenied"):
        with pytest.raises(LoadFailed, match=reason):
            _load(store, Warehouse(fail={TABLE: [reason]}))


def test_an_earlier_runs_failed_retries_never_block_a_later_run() -> None:
    client = Warehouse()
    failed = SimpleNamespace(state="DONE", error_result={"reason": "backendError", "message": "x"})
    client.jobs = {"j": failed, **{f"j_rOLD_{n}": failed for n in range(1, 5)}}

    def start(jid: str):
        if jid in client.jobs:
            raise Conflict(jid)
        client.started.append(jid)
        return SimpleNamespace(state="RUNNING", error_result=None, result=lambda: None)

    used = _run_job(client, "j", start, location="US", invocation="NEW", sleep=lambda _: None)
    assert used == "j_rNEW_1" and client.started == ["j_rNEW_1"]


def test_tables_share_the_pool_without_head_of_line_blocking() -> None:
    lock = threading.Lock()
    inflight: dict[str, int] = {}
    peak: dict[str, int] = {}
    order: list[str] = []

    def run(job: LoadJob) -> str:
        with lock:
            inflight[job.table_id] = inflight.get(job.table_id, 0) + 1
            peak[job.table_id] = max(peak.get(job.table_id, 0), inflight[job.table_id])
            order.append(job.table_id)
        time.sleep(0.01)
        with lock:
            inflight[job.table_id] -= 1
        return job.destination

    jobs = [LoadJob(HR, "a", f"a${m:06d}", []) for m in range(12)] + [
        LoadJob(HR, "b", f"b${m:06d}", []) for m in range(2)
    ]
    done, errors = _dispatch(jobs, run, concurrency=4, max_per_table=2)
    assert not errors and len(done) == 14 and peak == {"a": 2, "b": 2}
    assert order.index("b") < 2  # b starts right away instead of waiting behind a


class MarkerRace(GsStore):
    """Fails the marker swap; landed=True first writes the payload, as a retried upload that already landed would."""

    landed = False

    def write_versioned(self, uri, data, token):
        from mhc_export.io.blobstore import BlobConflict

        if not uri.endswith(".json"):
            return super().write_versioned(uri, data, token)
        if self.landed:
            self.write(uri, data, overwrite=True)
        raise BlobConflict(uri)


def test_a_marker_swap_lost_to_another_writer_is_refused(tmp_path) -> None:
    store = MarkerRace(tmp_path)
    _commit(GsStore(tmp_path), "r1", _entries("r1", [1]))
    with pytest.raises(LoadFailed, match="marker changed"):
        _load(store, Warehouse())
    assert not store.exists("gs://lake/bigquery/p.d.lock")


def test_a_marker_write_that_already_landed_counts_as_success(tmp_path) -> None:
    store = MarkerRace(tmp_path)
    store.landed = True
    _commit(GsStore(tmp_path), "r1", _entries("r1", [1]))
    assert _load(store, Warehouse())["whole_tables"] == [TABLE]


def test_one_load_per_destination_at_a_time(tmp_path) -> None:
    store = GsStore(tmp_path)
    _commit(store, "r1", _entries("r1", [1]))
    lock = "gs://lake/bigquery/p.d.lock"
    soon = datetime.now(UTC) + timedelta(hours=1)
    store.write(lock, json.dumps({"started_at": "x", "expires_at": soon.isoformat()}).encode(), overwrite=True)
    with pytest.raises(LoadFailed, match="holds"):
        _load(store, Warehouse())
    store.write(
        lock, json.dumps({"started_at": "x", "expires_at": "2020-01-01T00:00:00+00:00"}).encode(), overwrite=True
    )
    assert _load(store, Warehouse())["whole_tables"] == [TABLE] and not store.exists(lock)


def test_a_reload_that_never_landed_is_planned_again(tmp_path) -> None:
    store = GsStore(tmp_path)
    bq = Warehouse()
    _commit(store, "r1", _entries("r1", [1, 2, 3]))
    _load(store, bq)
    bq.drop(TABLE)
    bq.fail = {TABLE: ["invalid"]}
    with pytest.raises(LoadFailed):
        _load(store, bq)
    assert bq.tables[TABLE]["partitions"] == set()  # created empty, never filled
    third = _load(store, bq)
    assert third["whole_tables"] == [TABLE] and bq.tables[TABLE]["partitions"] == {"202501", "202502", "202503"}


def test_queued_loads_of_an_interrupted_run_are_awaited(tmp_path) -> None:
    store = GsStore(tmp_path)
    _commit(store, "r1", _entries("r1", [1]))
    waited: list[str] = []

    class Busy(Warehouse):
        def list_jobs(self, project=None, state_filter=None, **kw):
            job = SimpleNamespace(
                job_id=f"mhc_load_{state_filter}",
                destination=SimpleNamespace(project="p", dataset_id="d"),
                result=lambda: waited.append(state_filter),
            )
            return [job]

    _load(store, Busy())
    assert waited == ["pending", "running"]


@pytest.mark.parametrize("flags", [{"concurrency": 0}, {"max_per_table": 0}])
def test_load_concurrency_must_be_positive(tmp_path, flags) -> None:
    store = GsStore(tmp_path)
    _commit(store, "r1", _entries("r1", [1]))
    with pytest.raises(ValueError, match="at least 1"):
        _load(store, Warehouse(), **flags)


def test_lost_rows_are_reloaded_although_earlier_jobs_succeeded(tmp_path) -> None:
    store = GsStore(tmp_path)
    bq = Warehouse()
    months = list(range(1, 11))
    _commit(store, "r1", _entries("r1", months))
    _load(store, bq)
    assert bq.dispositions[TABLE] == "WRITE_TRUNCATE_DATA"
    bq.truncate(TABLE)  # same table instance, no rows
    assert _load(store, bq)["whole_tables"] == [TABLE]
    assert bq.tables[TABLE]["partitions"] == {f"2025{m:02d}" for m in months}
    bq.tables[TABLE]["partitions"].discard("202503")  # e.g. bq rm table$202503
    again = _load(store, bq)
    assert list(again["loads"]) == [f"{TABLE}$202503"] and "202503" in bq.tables[TABLE]["partitions"]
    assert bq.dispositions[f"{TABLE}$202503"] == "WRITE_TRUNCATE"


def test_the_lease_is_renewed_and_only_its_owner_releases_it(tmp_path) -> None:
    from mhc_export.run.bigquery import _DestinationLease

    store = GsStore(tmp_path)
    uri = "gs://lake/bigquery/p.d.lock"
    lease = _DestinationLease(store, uri, ttl=timedelta(minutes=1), renew_seconds=0.02)
    with lease:
        first = json.loads(store.read(uri))["expires_at"]
        time.sleep(0.1)
        assert json.loads(store.read(uri))["expires_at"] > first
        other = {"owner": "someone-else", "started_at": "x", "expires_at": "2999-01-01T00:00:00+00:00"}
        store.write(uri, json.dumps(other).encode(), overwrite=True)
        time.sleep(0.1)
        with pytest.raises(LoadFailed, match="lost"):
            lease.check()
    assert json.loads(store.read(uri))["owner"] == "someone-else"


def test_loads_go_ahead_without_permission_to_list_jobs(tmp_path) -> None:
    from google.api_core.exceptions import Forbidden

    store = GsStore(tmp_path)
    _commit(store, "r1", _entries("r1", [1]))

    class NoList(Warehouse):
        def list_jobs(self, **kw):
            raise Forbidden("bigquery.jobs.list")

    assert _load(store, NoList())["whole_tables"] == [TABLE]


def test_no_backoff_after_the_last_attempt() -> None:
    client = Warehouse()
    sleeps: list[float] = []

    def start(jid: str):
        return SimpleNamespace(state="DONE", error_result={"reason": "backendError", "message": "x"})

    with pytest.raises(LoadFailed, match="all 5 attempts"):
        _run_job(client, "j", start, location="US", invocation="i", sleep=sleeps.append)
    assert len(sleeps) == 4


def test_widen_pool_keeps_an_mtls_adapter() -> None:
    import requests

    from mhc_export.io.blobstore import widen_pool

    session = requests.Session()
    old = session.adapters["https://"]
    widen_pool(session, 20)
    assert session.adapters["https://"] is not old and session.adapters["https://"]._pool_maxsize == 20
    mtls = requests.Session()
    mtls.is_mtls = True
    kept = mtls.adapters["https://"]
    widen_pool(mtls, 20)
    assert mtls.adapters["https://"] is kept
