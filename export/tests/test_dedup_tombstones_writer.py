# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import io

import pyarrow as pa
import pyarrow.parquet as pq

from mhc_export.grove.view import parse_observation
from mhc_export.identity.grove_ids import HealthKitIdentity
from mhc_export.transform.dedup import dedup, tuple_collisions
from mhc_export.transform.project import ProjectContext, project
from mhc_export.transform.specs import default_registry
from mhc_export.transform.tombstones import retraction_targets, tombstone_ids, tombstones_from_csv
from mhc_export.transform.writer import (
    RowBuffer,
    read_parquet_metadata,
    rows_to_table,
    split_by_month,
    staging_uri,
    to_parquet_bytes,
)
from tests.conftest import pre_grove_heart_rate

HR = default_registry().get("HKQuantityTypeIdentifierHeartRate")
assert HR


def _row(ctx: ProjectContext, seq: int, **overrides) -> dict:
    res = pre_grove_heart_rate(**overrides)
    return project(parse_observation(res), HR, ctx, seq).row


def test_dedup_precedence(ctx: ProjectContext) -> None:
    a = _row(ctx, 1)  # archive copy, no writer version
    b = dict(_row(ctx, 2), from_archive=False)  # firestore copy of the same sample
    c = dict(_row(ctx, 3), writer_version="2", value=90.0)  # higher writer version wins over everything
    d = _row(ctx, 4, id="11111111-1111-1111-1111-111111111111", identifier=[])  # different sample
    table = rows_to_table([a, b, c, d], HR.arrow_schema)
    kept, removed = dedup(table)
    assert removed == 2 and kept.num_rows == 2
    by_id = {r["sample_id"]: r for r in kept.to_pylist()}
    assert by_id[a["sample_id"]]["value"] == 90.0
    table2 = rows_to_table([a, b, d], HR.arrow_schema)
    kept2, _ = dedup(table2)
    assert {r["sample_id"]: r["from_archive"] for r in kept2.to_pylist()}[a["sample_id"]] is False
    later = dict(a, converted_at=a["converted_at"] + 1000, value=70.0)
    kept3, _ = dedup(rows_to_table([a, later], HR.arrow_schema))
    assert kept3.to_pylist()[0]["value"] == 70.0


def test_dedup_is_idempotent_and_sorted(ctx: ProjectContext) -> None:
    rows = [
        _row(
            ctx,
            i,
            id=f"{i:08x}-0000-0000-0000-000000000000",
            identifier=[],
            effectiveDateTime=f"2026-08-0{9 - i}T10:00:00Z",
        )
        for i in range(1, 5)
    ]
    table = rows_to_table(rows, HR.arrow_schema)
    once, r1 = dedup(table)
    twice, r2 = dedup(once)
    assert r1 == 0 and r2 == 0 and once.equals(twice)
    starts = once["effective_start"].to_pylist()
    assert starts == sorted(starts)
    assert tuple_collisions(once) == 0


def test_tuple_collisions(ctx: ProjectContext) -> None:
    a = _row(ctx, 1)
    b = _row(ctx, 2, id="22222222-2222-2222-2222-222222222222", identifier=[])  # same content, different uuid
    table = rows_to_table([a, b], HR.arrow_schema)
    assert tuple_collisions(table) == 1


def test_tombstones(identity: HealthKitIdentity) -> None:
    stones, malformed = tombstones_from_csv(
        [
            {
                "sampleType": "HKQuantityTypeIdentifierHeartRate",
                "sampleId": "BDAC71F6-3398-4BDD-A56C-7BD50988D87A",
                "timestamp": "1787567716.438",
            },
            {
                "sampleType": "HKQuantityTypeIdentifierStepCount",
                "sampleId": "BDAC71F6-3398-4BDD-A56C-7BD50988D87A",
                "timestamp": "",
            },
            {"sampleType": "HKQuantityTypeIdentifierHeartRate", "sampleId": "garbage", "timestamp": "x"},
            {"sampleType": "", "sampleId": "", "timestamp": ""},
        ]
    )
    assert len(stones) == 3 and malformed == 1 and stones[0].timestamp == 1787567716.438 and stones[1].timestamp is None
    ids, bad = tombstone_ids(stones, HR, identity)
    assert bad == 1
    assert ids == {
        identity.source_output(
            "HKQuantityTypeIdentifierHeartRate", "bdac71f6-3398-4bdd-a56c-7bd50988d87a", "heart-rate"
        )
    }


def test_retraction_targets() -> None:
    role = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role"
    bundle = {
        "resourceType": "Bundle",
        "entry": [
            {
                "resource": {
                    "resourceType": "Provenance",
                    "target": [
                        {
                            "type": "Observation",
                            "identifier": {
                                "type": {"coding": [{"system": role, "code": "source-output"}]},
                                "value": "v0:k:1:X",
                            },
                        },
                        {
                            "type": "Device",
                            "identifier": {
                                "type": {"coding": [{"system": role, "code": "device-snapshot"}]},
                                "value": "v0:k:1:Y",
                            },
                        },
                    ],
                }
            }
        ],
    }
    assert retraction_targets(bundle) == {"v0:k:1:X"}


def test_writer_roundtrip_metadata_and_months(ctx: ProjectContext) -> None:
    rows = [
        _row(ctx, 1, effectiveDateTime="2026-01-31T23:30:00-08:00"),  # 2026-02-01 UTC
        _row(
            ctx, 2, id="22222222-2222-2222-2222-222222222222", identifier=[], effectiveDateTime="2026-01-15T10:00:00Z"
        ),
    ]
    table = rows_to_table(rows, HR.arrow_schema)
    parts = list(split_by_month(table))
    assert [(y, m, t.num_rows) for y, m, t in parts] == [(2026, 1, 1), (2026, 2, 1)]
    data = to_parquet_bytes(table, extra_metadata={"export_run_id": "r-test"})
    back = pq.read_table(io.BytesIO(data))
    assert back.schema.field("effective_start").type == pa.timestamp("us", tz="UTC")
    assert back.num_rows == 2 and back.column("value").to_pylist() == [84.0, 84.0]
    md = read_parquet_metadata(data)
    assert md["sample_type"] == "HKQuantityTypeIdentifierHeartRate" and md["row_count"] == "2"
    assert md["covered_start"] == "2026-01-15T10:00:00.000Z" and md["covered_end"] == "2026-02-01T07:30:00.000Z"
    assert md["participant_count"] == "1" and md["export_run_id"] == "r-test"
    assert staging_uri(
        "gs://b/staging/r1", "HKQuantityTypeIdentifierHeartRate", 2026, 2, "uid:HKQuantityTypeIdentifierHeartRate"
    ) == (
        "gs://b/staging/r1/HKQuantityTypeIdentifierHeartRate/year=2026/month=02/uid__HKQuantityTypeIdentifierHeartRate.parquet"
    )
    assert to_parquet_bytes(HR.arrow_schema.empty_table()) and split_by_month(HR.arrow_schema.empty_table())


def test_row_buffer_chunks(ctx: ProjectContext) -> None:
    buf = RowBuffer(HR.arrow_schema, chunk_size=2)
    for i in range(5):
        buf.append(_row(ctx, i))
    table = buf.to_table()
    assert table.num_rows == 5 and buf.count == 5 and table.schema.equals(HR.arrow_schema)
    assert RowBuffer(HR.arrow_schema).to_table().num_rows == 0
