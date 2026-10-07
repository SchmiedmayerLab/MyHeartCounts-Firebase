# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from google.api_core.exceptions import Conflict

from mhc_export.run.bigquery import _run_job, bigquery_schema, job_id, plan_loads, table_name
from mhc_export.run.lake import CurrentPointer, DatasetEntry
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


def test_job_ids_are_deterministic_and_valid() -> None:
    jid = job_id("r2026-10", HR, 2025, 12)
    assert jid == job_id("r2026-10", HR, 2025, 12) and jid.startswith("mhc_load_r2026-10_")
    assert all(c.isalnum() or c in "_-" for c in jid) and table_name(HR) in jid


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
