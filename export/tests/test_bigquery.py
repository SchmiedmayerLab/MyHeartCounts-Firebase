# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import Conflict

from mhc_export.io.blobstore import LocalBlobStore
from mhc_export.run.bigquery import _run_job, bigquery_schema, job_id, load_committed, plan_loads, table_name
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


def test_plan_loads_only_changed_partitions_and_deletes_vanished_ones() -> None:
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
    assert plan.deletes == [(HR, 2025, 10)]
    assert len(plan_loads("gs://lake", POINTER, current, previous, full=True).loads) == 3


def test_job_ids_depend_on_destination_and_files() -> None:
    dest = f"p.mhc_export.{table_name(HR)}$202512"
    jid = job_id(dest, ["gs://lake/a.parquet"])
    assert jid == job_id(dest, ["gs://lake/a.parquet"]) and jid.startswith(f"mhc_load_{table_name(HR)}_202512_")
    assert all(c.isalnum() or c in "_-" for c in jid) and len(jid) <= 1024
    assert jid != job_id(dest.replace("mhc_export", "other"), ["gs://lake/a.parquet"])
    assert jid != job_id(dest, ["gs://lake/b.parquet"]) and jid != job_id(dest, ["gs://lake/a.parquet"], "full")


class FakeClient:
    def __init__(self, existing: dict[str, SimpleNamespace]) -> None:
        self.existing = existing
        self.started: list[str] = []

    def get_job(self, jid: str) -> SimpleNamespace:
        return self.existing[jid]


def _start(client: FakeClient):
    def start(jid: str) -> SimpleNamespace:
        if jid in client.existing:
            raise Conflict("exists")
        client.started.append(jid)
        return SimpleNamespace(result=lambda: None)

    return start


def test_run_job_reuses_a_successful_job_and_retries_a_failed_one() -> None:
    done = SimpleNamespace(state="DONE", error_result=None)
    failed = SimpleNamespace(state="DONE", error_result={"reason": "invalid"})
    client = FakeClient({"j": done})
    assert _run_job(client, "j", _start(client)) == "j" and client.started == []
    client = FakeClient({"j": failed})
    assert _run_job(client, "j", _start(client)) == "j_retry1" and client.started == ["j_retry1"]
    client = FakeClient({})
    assert _run_job(client, "j", _start(client)) == "j" and client.started == ["j"]


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


class Warehouse:
    """In-memory stand-in for the BigQuery client calls the loader makes."""

    def __init__(self, fail_on: set[str] | None = None) -> None:
        self.partitions: dict[str, set[str]] = {}
        self.jobs: dict[str, SimpleNamespace] = {}
        self.loaded: list[str] = []
        self.fail_on = fail_on or set()

    def get_table(self, table_id: str):
        from google.api_core.exceptions import NotFound

        if table_id not in self.partitions:
            raise NotFound(table_id)

    def create_table(self, table, exists_ok: bool = False) -> None:
        self.partitions.setdefault(f"{table.project}.{table.dataset_id}.{table.table_id}", set())

    def list_tables(self, dataset: str):
        return [SimpleNamespace(table_id=t.rsplit(".", 1)[1]) for t in self.partitions if t.startswith(dataset + ".")]

    def list_partitions(self, table_id: str) -> list[str]:
        return sorted(self.partitions[table_id])

    def load_table_from_uri(self, uris, destination, job_config=None, job_id=None):
        if job_id in self.jobs:
            raise Conflict(job_id)
        table, _, decorator = destination.partition("$")
        failed = destination in self.fail_on
        self.jobs[job_id] = SimpleNamespace(state="DONE", error_result={"reason": "x"} if failed else None)
        if failed:
            return SimpleNamespace(result=lambda: (_ for _ in ()).throw(RuntimeError(f"load of {destination} failed")))
        self.partitions[table].add(decorator)
        self.loaded.append(destination)
        return SimpleNamespace(result=lambda: None)

    def get_job(self, jid: str) -> SimpleNamespace:
        return self.jobs[jid]

    def delete_table(self, destination: str, not_found_ok: bool = False) -> None:
        table, _, decorator = destination.partition("$")
        self.partitions.get(table, set()).discard(decorator)


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


def test_loads_diff_against_what_the_warehouse_holds(tmp_path) -> None:
    store = GsStore(tmp_path)
    table = f"p.d.{table_name(HR)}"
    oct_, nov = entry("v1/HR/10/part-r1-0.parquet", 2025, 10, "r1"), entry("v1/HR/11/part-r1-0.parquet", 2025, 11, "r1")
    _commit(store, "r1", [oct_, nov])
    bq = Warehouse()
    load_committed(store, "gs://lake", "p", "d", client=bq)
    assert bq.partitions[table] == {"202510", "202511"}
    # r2 empties October, replaces November and adds December; the December load fails
    nov2, dec = entry("v1/HR/11/part-r2-0.parquet", 2025, 11, "r2"), entry("v1/HR/12/part-r2-0.parquet", 2025, 12, "r2")
    _commit(store, "r2", [nov2, dec])
    failing = Warehouse(fail_on={f"{table}$202512"})
    failing.partitions, failing.jobs = bq.partitions, bq.jobs
    with pytest.raises(RuntimeError, match="202512"):
        load_committed(store, "gs://lake", "p", "d", client=failing)
    # r3 changes nothing the warehouse missed on its own, yet the next load still catches up from r1's state
    _commit(store, "r3", [nov2, dec])
    record = load_committed(store, "gs://lake", "p", "d", client=bq)
    assert record["baseline_run_id"] == "r1" and bq.partitions[table] == {"202511", "202512"}
    assert sorted(record["loads"]) == [f"{table}$202511", f"{table}$202512"]
    assert record["deletes"] == [f"{table}$202510"]
    # nothing left to do, and a second destination gets its own full load
    again = load_committed(store, "gs://lake", "p", "d", client=bq)
    assert again["loads"] == {} and again["deletes"] == []
    other = load_committed(store, "gs://lake", "p", "e", client=bq)
    assert sorted(other["loads"]) == [f"p.e.{table_name(HR)}$202511", f"p.e.{table_name(HR)}$202512"]
