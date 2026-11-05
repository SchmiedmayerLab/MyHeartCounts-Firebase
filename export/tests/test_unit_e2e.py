# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
from pathlib import Path

import orjson
import pyarrow.parquet as pq
import zstandard

from mhc_export.cli import main
from mhc_export.io.blobstore import LocalBlobStore, ObjectInfo
from mhc_export.run.models import UploadKind
from mhc_export.sources.bucket import classify, plan_units
from tests.conftest import pre_grove_heart_rate

UID = "user-abc"
TEST_KEY_HEX = bytes(range(32)).hex()


def _zstd(data: bytes) -> bytes:
    return zstandard.ZstdCompressor(write_content_size=False).compress(data)


def build_source(root: Path, uid: str = UID) -> None:
    hist = root / "users" / uid / "historicalHealthSamples"
    live = root / "users" / uid / "liveHealthSamples"
    dels = root / "users" / uid / "healthDeletions"
    for d in (hist, live, dels):
        d.mkdir(parents=True)
    samples = [
        pre_grove_heart_rate(
            id=f"{i:08x}-0000-4000-8000-000000000000",
            identifier=[],
            effectiveDateTime=f"2025-12-{10 + i:02d}T10:00:00+01:00",
        )
        for i in range(5)
    ]
    (hist / "HKQuantityTypeIdentifierHeartRate_A.json.zstd").write_bytes(_zstd(orjson.dumps(samples[:3])))
    # live re-uploads sample 2 (duplicate), adds 3 and 4 and one in another month
    live_samples = samples[2:] + [
        pre_grove_heart_rate(
            id="99999999-0000-4000-8000-000000000000", identifier=[], effectiveDateTime="2026-01-02T10:00:00+01:00"
        )
    ]
    (live / "HKQuantityTypeIdentifierHeartRate_B.json.zstd").write_bytes(_zstd(orjson.dumps(live_samples)))
    # a non-final and a clinical envelope that must be dropped
    junk = [pre_grove_heart_rate(status="preliminary"), {"version": "R4", "resource": {"resourceType": "Condition"}}]
    (live / "HKQuantityTypeIdentifierHeartRate_C.json.zstd").write_bytes(_zstd(orjson.dumps(junk)))
    # steps, unit text only
    steps = pre_grove_heart_rate(
        code={
            "coding": [
                {
                    "system": "http://developer.apple.com/documentation/healthkit",
                    "code": "HKQuantityTypeIdentifierStepCount",
                }
            ]
        },
        valueQuantity={"value": 300, "unit": "steps"},
        effectivePeriod={"start": "2025-12-01T08:00:00+01:00", "end": "2025-12-01T09:00:00+01:00"},
    )
    del steps["effectiveDateTime"]
    (hist / "HKQuantityTypeIdentifierStepCount_D.json.zstd").write_bytes(_zstd(orjson.dumps([steps])))
    # an unsupported type (ECG) must be skipped, not fail
    (hist / "HKDataTypeIdentifierElectrocardiogram_E.json.zstd").write_bytes(
        _zstd(orjson.dumps([pre_grove_heart_rate()]))
    )
    # deletion of sample 4
    csv = (
        "sampleType,sampleId,timestamp\r\n"
        "HKQuantityTypeIdentifierHeartRate,00000004-0000-4000-8000-000000000000,1787567716.438\r\n"
    )
    (dels / "HKQuantityTypeIdentifierHeartRate_F.csv.zstd").write_bytes(_zstd(csv.encode()))
    # noise that must be ignored
    (root / "users" / uid / "consent").mkdir()
    (root / "users" / uid / "consent" / "consent.pdf").write_bytes(b"%PDF")


def test_classify_and_plan(tmp_path: Path) -> None:
    build_source(tmp_path)
    store = LocalBlobStore(tmp_path)
    units = plan_units(store.list(""))
    by_id = {u.unit_id: u for u in units}
    hr = by_id[f"{UID}:HKQuantityTypeIdentifierHeartRate"]
    assert [o.upload_kind for o in hr.objects] == [
        UploadKind.HISTORICAL,
        UploadKind.LIVE,
        UploadKind.LIVE,
        UploadKind.DELETIONS,
    ]
    assert set(by_id) == {
        f"{UID}:HKQuantityTypeIdentifierHeartRate",
        f"{UID}:HKQuantityTypeIdentifierStepCount",
        f"{UID}:HKDataTypeIdentifierElectrocardiogram",
    }
    assert classify(ObjectInfo("users/x/consent/a.pdf", 1, None, None, {})) is None
    v1 = classify(
        ObjectInfo(
            "gs://b/u1/2026/09/HKQuantityTypeIdentifierHeartRate/abc.json.zstd",
            1,
            5,
            None,
            {"upload_kind": "historical"},
        )
    )
    assert (
        v1
        and v1[0] == "u1"
        and v1[1] == "HKQuantityTypeIdentifierHeartRate"
        and v1[2].upload_kind == UploadKind.HISTORICAL
    )
    assert (
        plan_units(store.list(""), sample_types={"HKQuantityTypeIdentifierStepCount"})[0].sample_type
        == "HKQuantityTypeIdentifierStepCount"
    )


def test_run_local_end_to_end(tmp_path: Path) -> None:
    src = tmp_path / "src"
    out = tmp_path / "out"
    build_source(src)
    rc = main(
        [
            "run-local",
            "--source",
            str(src),
            "--out",
            str(out),
            "--run-id",
            "r1",
            "--key-hex",
            TEST_KEY_HEX,
            "--allow-test-key",
            "--accept-legacy",
        ]
    )
    assert rc == 0
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    r = report["report"]
    assert r["units_total"] == 3 and r["units_done"] == 3 and r["units_failed"] == 0
    hr = report["units"][f"{UID}:HKQuantityTypeIdentifierHeartRate"]
    assert hr["rows_in"] == 9 and hr["drops"] == {"non_final": 1, "clinical_record": 1}
    assert hr["dedup_removed"] == 1 and hr["tombstoned"] == 1 and hr["rows_out"] == 5
    assert sorted(hr["parts"]) == [
        "staging/r1/HKQuantityTypeIdentifierHeartRate/year=2025/month=12/user-abc__HKQuantityTypeIdentifierHeartRate.parquet",
        "staging/r1/HKQuantityTypeIdentifierHeartRate/year=2026/month=01/user-abc__HKQuantityTypeIdentifierHeartRate.parquet",
    ]
    assert report["units"][f"{UID}:HKDataTypeIdentifierElectrocardiogram"]["skipped_reason"].startswith("deferred:")
    table = pq.read_table(out / hr["parts"][0])
    assert table.num_rows == 4 and table.column("participant_id").unique().to_pylist() != [UID]
    participants = json.loads((out / "private" / "participants.json").read_text())
    assert set(participants) == {UID}
    # re-run: identical output, nothing duplicated
    rc2 = main(
        [
            "run-local",
            "--source",
            str(src),
            "--out",
            str(out),
            "--run-id",
            "r1",
            "--key-hex",
            TEST_KEY_HEX,
            "--allow-test-key",
            "--accept-legacy",
        ]
    )
    assert rc2 == 0
    assert pq.read_table(out / hr["parts"][0]).equals(table)


def test_json_deletions_are_planned_as_deletions() -> None:
    from mhc_export.io.blobstore import ObjectInfo

    hit = classify(
        ObjectInfo(
            "users/u1/healthDeletions/HKQuantityTypeIdentifierHeartRate_0123456789abcdef01234567.json.zstd",
            9,
            None,
            None,
            {},
        )
    )
    assert (
        hit
        and hit[0] == "u1"
        and hit[1] == "HKQuantityTypeIdentifierHeartRate"
        and hit[2].upload_kind == UploadKind.DELETIONS
    )
    assert (
        classify(
            ObjectInfo("users/u1/liveHealthSamples/HKQuantityTypeIdentifierHeartRate_ab.csv.zstd", 9, None, None, {})
        )
        is None
    )
