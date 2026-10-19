# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Grove exchange events through process_unit: identities, descriptors, retractions and fail-closed input."""

import io
import json
from pathlib import Path

import orjson
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import zstandard

from mhc_export.cli import main
from mhc_export.config import GroveSettings, IdentityConfig
from mhc_export.identity.grove_ids import GroveKey
from mhc_export.identity.participants import LocalParticipantLookup
from mhc_export.io.blobstore import LocalBlobStore, RoutedStore
from mhc_export.run.unit import Deps, ledger_part_uri, process_unit
from mhc_export.sources.bucket import plan_units
from mhc_export.transform.specs import default_registry
from tests.conftest import TEST_KEY, pre_grove_heart_rate
from tests.grove_hk import HR, hk_event, hk_retraction, native, observation
from tests.test_unit_e2e import TEST_KEY_HEX

UID = "grove-user"
FIXTURES = Path(__file__).parent / "fixtures" / "grove"
STEPS = "HKQuantityTypeIdentifierStepCount"


def _zstd(data: bytes) -> bytes:
    return zstandard.ZstdCompressor(write_content_size=False).compress(data)


def _write(root: Path, kind: str, name: str, elements: list, sample_type: str = HR) -> None:
    folder = root / "users" / UID / kind
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{sample_type}_{name}.json.zstd").write_bytes(_zstd(orjson.dumps(elements)))


def _deps(tmp_path: Path, src: Path, **kw) -> Deps:
    return Deps(
        store=RoutedStore(LocalBlobStore(src), LocalBlobStore(tmp_path / "out")),
        registry=default_registry(),
        identity=IdentityConfig(TEST_KEY),
        participants=LocalParticipantLookup(tmp_path / "p.json"),
        staging_prefix="staging/r1",
        run_id="r1",
        **kw,
    )


def _process(tmp_path: Path, src: Path, sample_type: str = HR, **kw):
    deps = _deps(tmp_path, src, **kw)
    (unit,) = plan_units(LocalBlobStore(src).list(""), sample_types={sample_type})
    return unit, deps, process_unit(unit, deps)


def _rows(tmp_path: Path, result) -> list[dict]:
    out = LocalBlobStore(tmp_path / "out")
    tables = [pq.read_table(io.BytesIO(out.read(uri))) for uri in result.parts]
    return pa.concat_tables(tables).to_pylist() if tables else []


def test_an_active_event_exports_its_descriptors_under_export_identities(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [hk_event(UID, native(1), writer=("sync-1", "3"))])
    unit, deps, result = _process(tmp_path, src)
    assert result.rows_out == 1 and not result.drops and not result.fatal and not result.warnings
    (row,) = _rows(tmp_path, result)
    identity = deps.identity.for_participant(row["participant_id"])
    assert row["sample_id"] == identity.source_output(HR, native(1), "heart-rate")
    assert row["source_record_id"] == identity.source_record(HR, native(1))
    assert row["value"] == 72.0 and row["unit"] == "/min" and row["utc_offset_min"] == -420
    assert (row["device_manufacturer"], row["device_model"]) == ("Apple Inc.", "Watch7,1")
    assert (row["device_hardware"], row["device_software"], row["device_firmware"]) == ("Watch7,1", "11.0", "1.2")
    assert row["source_bundle_hash"].startswith("v0:test-key:1:") and row["source_version"] == "11.0"
    assert (row["app_version"], row["app_build"], row["study_revision"]) == ("3.1.0", "412", 44)
    assert row["recording_method"] == "automatically-recorded"
    assert row["writer_record_id"].startswith("v0:store:1:") and row["writer_version"] == "3"
    assert row["converted_at"].timestamp() == 1787247002  # the conversion Provenance's recorded instant
    text = json.dumps(row, default=str)
    assert UID not in text and native(1) not in text.upper() and "com.apple.health" not in text


def test_legacy_and_grove_copies_of_one_sample_share_its_id(tmp_path: Path) -> None:
    src = tmp_path / "src"
    legacy = pre_grove_heart_rate(id=native(5), identifier=[], effectiveDateTime="2026-08-20T08:30:00.251-07:00")
    _write(src, "historicalHealthSamples", "aa01", [legacy])
    _write(src, "liveHealthSamples", "aa02", [hk_event(UID, native(5))])
    _, _, result = _process(tmp_path, src, grove=GroveSettings(accept_legacy=True))
    assert result.rows_in == 2 and result.rows_out == 1 and result.dedup_removed == 1


def test_legacy_resources_need_the_explicit_flag(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [pre_grove_heart_rate(id=native(1)), hk_event(UID, native(2))])
    with pytest.raises(RuntimeError, match="grove_not_bundle"):
        _process(tmp_path, src)
    _, _, tolerated = _process(tmp_path, src, tolerate_unreadable=True)
    assert tolerated.fatal == {"grove_not_bundle": 1} and tolerated.rows_out == 1


def test_a_grove_retraction_removes_the_sample_and_reaches_the_ledger(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [hk_event(UID, native(1)), hk_event(UID, native(2), seq=2)])
    _write(src, "healthDeletions", "aa02", [hk_retraction(UID, native(1), seq=3), hk_retraction(UID, native(9), seq=4)])
    unit, deps, result = _process(tmp_path, src)
    assert result.rows_out == 1 and result.tombstoned == 1
    assert result.grove_retractions == 2 and result.tombstones_seen == 2
    identity = deps.identity.for_participant(_rows(tmp_path, result)[0]["participant_id"])
    assert _rows(tmp_path, result)[0]["sample_id"] == identity.source_output(HR, native(2), "heart-rate")
    ledger = pq.read_table(io.BytesIO(LocalBlobStore(tmp_path / "out").read(ledger_part_uri("staging/r1", unit))))
    assert set(ledger["sample_id"].to_pylist()) == {identity.source_output(HR, native(n), "heart-rate") for n in (1, 9)}


def test_csv_tombstones_and_grove_retractions_both_apply(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [hk_event(UID, native(n), seq=n) for n in (1, 2, 3)])
    _write(src, "healthDeletions", "aa02", [hk_retraction(UID, native(1), seq=9)])
    csv = f"sampleType,sampleId,timestamp\r\n{HR},{native(2)},1787567716.438\r\n"
    (src / "users" / UID / "healthDeletions" / f"{HR}_aa03.csv.zstd").write_bytes(_zstd(csv.encode()))
    _, _, result = _process(tmp_path, src)
    assert result.rows_out == 1 and result.tombstoned == 2 and result.grove_retractions == 1


@pytest.mark.parametrize(
    ("kind", "elements", "reason"),
    [
        ("healthDeletions", [hk_event(UID, native(1))], "grove_unexpected_active_event"),
        ("healthDeletions", [pre_grove_heart_rate()], "grove_not_bundle"),
        ("healthDeletions", [hk_retraction(UID, native(1), disclose_native=False)], "grove_retraction_unmapped"),
        ("liveHealthSamples", [hk_event("someone-else", native(1))], "grove_subject_mismatch"),
        (
            "liveHealthSamples",
            [hk_event(UID, native(1), sample_type=STEPS, measurement="step-count")],
            "grove_source_type_mismatch",
        ),
        ("liveHealthSamples", [hk_event(UID, native(1), code=("http://loinc.org", "1-1"))], "grove_code_mismatch"),
        (
            "liveHealthSamples",
            [hk_event(UID, native(1), key=GroveKey(TEST_KEY.secret, "migrator", 1))],
            "foreign_identity",
        ),
    ],
)
def test_broken_events_fail_the_unit(tmp_path: Path, kind: str, elements: list, reason: str) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa00", [hk_event(UID, native(7), seq=7)])
    _write(src, kind, "aa01", elements)
    with pytest.raises(RuntimeError, match=reason):
        _process(tmp_path, src)
    _, _, tolerated = _process(tmp_path, src, tolerate_unreadable=True)
    assert tolerated.fatal == {reason: 1} and tolerated.rows_out == 1


def test_a_bare_grove_resource_is_not_legacy_input(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [observation(hk_event(UID, native(1)))])
    with pytest.raises(RuntimeError, match="outside an exchange Bundle"):
        _process(tmp_path, src, grove=GroveSettings(accept_legacy=True))


def test_a_record_id_that_is_not_a_uuid_fails_the_event(tmp_path: Path) -> None:
    src = tmp_path / "src"
    event = hk_event(UID, native(1))
    observation(event)["identifier"][2]["value"] = "not-a-uuid"
    _write(src, "liveHealthSamples", "aa01", [event])
    with pytest.raises(RuntimeError, match="bad_native_identifier"):
        _process(tmp_path, src)


def test_an_added_producer_namespace_is_accepted(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [hk_event(UID, native(1), key=GroveKey(TEST_KEY.secret, "migrator", 1))])
    grove = GroveSettings(producer_namespaces=(("store", 1), ("migrator", 1)))
    _, _, result = _process(tmp_path, src, grove=grove)
    assert result.rows_out == 1 and not result.fatal


def test_the_higher_writer_version_wins(tmp_path: Path) -> None:
    src = tmp_path / "src"
    old = hk_event(UID, native(1), writer=("sync-1", "9007199254740992"), seq=1)
    new = hk_event(UID, native(1), writer=("sync-1", "9007199254740993"), seq=2, recorded="2026-08-21T10:00:00Z")
    observation(new)["valueQuantity"]["value"] = 75
    _write(src, "liveHealthSamples", "aa01", [new, old])
    _, _, result = _process(tmp_path, src)
    (row,) = _rows(tmp_path, result)
    assert result.dedup_removed == 1 and row["value"] == 75.0 and row["writer_version"] == "9007199254740993"


@pytest.mark.parametrize(
    ("sample_type", "codings", "expected"),
    [
        (
            "HKCategoryTypeIdentifierAppleStandHour",
            [("https://grovealliance.org/fhir/healthkit/CodeSystem/healthkit-apple-stand-hour", "stood")],
            ("stood", "stood"),
        ),
        (
            "HKCategoryTypeIdentifierPregnancy",
            [("https://grovealliance.org/fhir/healthkit/CodeSystem/healthkit-pregnancy-status", "pregnant")],
            ("pregnant", "pregnant"),
        ),
        (
            "HKCategoryTypeIdentifierSleepAnalysis",
            [
                ("https://grovealliance.org/fhir/mobile/CodeSystem/grove-sleep-stage", "deep"),
                ("https://grovealliance.org/fhir/healthkit/CodeSystem/healthkit-sleep-analysis", "asleepDeep"),
            ],
            ("deep", "asleepDeep"),
        ),
    ],
)
def test_category_values_are_read_from_the_result_code_system(
    tmp_path: Path, sample_type: str, codings: list, expected: tuple
) -> None:
    spec = default_registry().get(sample_type)
    value = {"valueCodeableConcept": {"coding": [{"system": s, "code": c} for s, c in codings]}}
    period = {"effectivePeriod": {"start": "2026-08-20T08:00:00-07:00", "end": "2026-08-20T09:00:00-07:00"}}
    event = hk_event(
        UID,
        native(1),
        sample_type=sample_type,
        measurement=spec.measurement_id,
        code=spec.code,
        value=value,
        effective=period,
    )
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [event], sample_type=sample_type)
    _, _, result = _process(tmp_path, src, sample_type)
    (row,) = _rows(tmp_path, result)
    assert (row["value_code"], row["value_source_code"]) == expected and not result.drops
    observation(event)["valueCodeableConcept"]["coding"] = [
        {"system": "https://grovealliance.org/fhir/mobile/CodeSystem/other", "code": codings[0][1]}
    ]
    _write(src, "liveHealthSamples", "aa01", [event], sample_type=sample_type)
    with pytest.raises(RuntimeError, match="grove_value_system"):
        _process(tmp_path, src, sample_type)


def test_pinned_fixtures_fail_for_their_adapter_not_their_structure(tmp_path: Path) -> None:
    """The pinned Grove examples are structurally valid but not HealthKit adapter output."""
    study = GroveSettings(
        deployment_root="https://study.example.org/fhir",
        producer_namespaces=(("test-key", 1),),
        participant_system="https://study.example.org/fhir/identifiers/participant",
    )
    for name, kind, reason in (
        ("exchange-bundle", "liveHealthSamples", "grove_not_healthkit"),
        ("retraction-bundle", "healthDeletions", "grove_retraction_unmapped"),
    ):
        src = tmp_path / name
        _write(src, kind, "aa01", [json.loads((FIXTURES / "mobile-exchange" / f"{name}.json").read_text())])
        with pytest.raises(RuntimeError, match=reason):
            _process(tmp_path, src, grove=study)


def _run_local(tmp_path: Path, src: Path, *extra: str) -> int:
    return main(
        [
            "run-local",
            "--source",
            str(src),
            "--out",
            str(tmp_path / "out"),
            "--run-id",
            "r1",
            "--key-hex",
            TEST_KEY_HEX,
            "--allow-test-key",
            "--phases",
            "work",
            *extra,
        ]
    )


def test_cli_records_grove_settings_and_guards_production(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write(src, "liveHealthSamples", "aa01", [hk_event(UID, native(1))])
    assert _run_local(tmp_path, src, "--producer-namespace", "store:1", "--producer-namespace", "store:2") == 0
    report = json.loads((tmp_path / "out" / "runs" / "r1" / "report.json").read_text())
    grove = report["report"]["grove"]
    assert grove["producer_namespaces"] == ["store:1", "store:2"] and grove["accept_legacy"] is False
    assert report["report"]["totals"]["rows_out"] == 1
    with pytest.raises(SystemExit, match="--accept-legacy is not allowed with --production"):
        _run_local(tmp_path, src, "--accept-legacy", "--production")
    for bad in ("store", "store:0", ":1", "a:b:1"):
        with pytest.raises(SystemExit, match="--producer-namespace"):
            _run_local(tmp_path, src, "--producer-namespace", bad)
