# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import copy

import pytest

from mhc_export.grove.view import parse_observation
from mhc_export.transform.project import ProjectContext, ProjectError, project
from mhc_export.transform.specs import default_registry
from tests.conftest import pre_grove_heart_rate

REG = default_registry()
HR = REG.get("HKQuantityTypeIdentifierHeartRate")
STEPS = REG.get("HKQuantityTypeIdentifierStepCount")
SLEEP = REG.get("HKCategoryTypeIdentifierSleepAnalysis")
MASS = REG.get("HKQuantityTypeIdentifierBodyMass")
assert HR and STEPS and SLEEP and MASS


def test_view_pre_grove() -> None:
    v = parse_observation(pre_grove_heart_rate())
    assert v.shape == "pre-grove" and v.sample_type == "HKQuantityTypeIdentifierHeartRate"
    assert v.native_uuid == "BDAC71F6-3398-4BDD-A56C-7BD50988D87A"
    assert v.device and v.device.hardware == "Watch7,12" and v.device.manufacturer == "Apple Inc."
    assert v.source and v.source.bundle_identifier.startswith("com.apple.health.") and v.source.version == "31.2"
    assert v.upload_timezone == "America/Los_Angeles" and v.study_revision == 42
    assert v.motion_context_raw == 1 and v.quantity and v.quantity.code == "/min"


def test_project_heart_rate(ctx: ProjectContext) -> None:
    p = project(parse_observation(pre_grove_heart_rate()), HR, ctx, 7)
    row = p.row
    assert p.warnings == ()
    assert row["sample_id"].startswith("v0:test-key:1:") and row["source_record_id"] != row["sample_id"]
    assert row["value"] == 84.0 and row["unit"] == "/min" and row["value_code"] is None
    assert row["effective_start"] == 1786143817798 and row["effective_end"] is None
    assert row["utc_offset_min"] == -420 and row["timezone"] == "America/Los_Angeles"
    assert row["motion_context"] == "sedentary"
    assert row["device_model"] == "Watch" and row["source_bundle_hash"].startswith("v0:")
    assert row["study_revision"] == 42 and row["converted_at"] == 1786143899341
    assert row["writer_record_id"] is None and row["recording_method"] is None
    assert row["export_seq"] == 7 and row["export_run_id"] == "r-test" and row["upload_kind"] == "live"
    assert set(row) == set(HR.column_names)
    # deterministic: same input -> same identities
    assert project(parse_observation(pre_grove_heart_rate()), HR, ctx, 8).row["sample_id"] == row["sample_id"]


def test_project_timezone_dropped_when_offset_disagrees(ctx: ProjectContext) -> None:
    res = pre_grove_heart_rate(effectiveDateTime="2026-08-07T16:03:37+02:00")
    assert project(parse_observation(res), HR, ctx, 1).row["timezone"] is None


def test_project_sample_timezone_wins(ctx: ProjectContext) -> None:
    res = pre_grove_heart_rate()
    res["extension"][2]["extension"].append(
        {"url": "https://bdh.stanford.edu/fhir/defs/metadata/HKTimeZone", "valueString": "America/Vancouver"}
    )
    assert project(parse_observation(res), HR, ctx, 1).row["timezone"] == "America/Vancouver"


def test_project_steps_unit_alias_and_period(ctx: ProjectContext) -> None:
    res = pre_grove_heart_rate(
        code={
            "coding": [
                {
                    "system": "http://developer.apple.com/documentation/healthkit",
                    "code": "HKQuantityTypeIdentifierStepCount",
                }
            ]
        },
        valueQuantity={"value": 112, "unit": "steps"},
        effectivePeriod={"start": "2026-09-09T18:34:43.873790383+02:00", "end": "2026-09-09T18:35:43.070838093+02:00"},
    )
    del res["effectiveDateTime"]
    row = project(parse_observation(res), STEPS, ctx, 1).row
    assert row["value"] == 112.0 and row["unit"] == "{steps}"
    assert row["effective_end"] - row["effective_start"] == 59197


def test_project_body_mass_converts_pounds(ctx: ProjectContext) -> None:
    res = pre_grove_heart_rate(
        code={
            "coding": [
                {
                    "system": "http://developer.apple.com/documentation/healthkit",
                    "code": "HKQuantityTypeIdentifierBodyMass",
                }
            ]
        },
        valueQuantity={"value": 166.449, "unit": "lbs", "code": "[lb_av]", "system": "http://unitsofmeasure.org"},
    )
    row = project(parse_observation(res), MASS, ctx, 1).row
    assert row["value"] == pytest.approx(75.5, abs=0.01) and row["unit"] == "kg"


def test_project_sleep_category(ctx: ProjectContext) -> None:
    res = pre_grove_heart_rate(
        code={
            "coding": [
                {
                    "system": "http://developer.apple.com/documentation/healthkit",
                    "code": "HKCategoryTypeIdentifierSleepAnalysis",
                }
            ]
        },
        effectivePeriod={"start": "2026-09-09T23:00:00+02:00", "end": "2026-09-10T00:30:00+02:00"},
        valueCodeableConcept={
            "coding": [
                {
                    "system": "https://developer.apple.com/documentation/healthkit/hkcategoryvaluesleepanalysis",
                    "code": "3",
                }
            ]
        },
    )
    del res["effectiveDateTime"]
    del res["valueQuantity"]
    row = project(parse_observation(res), SLEEP, ctx, 1).row
    assert row["value_code"] == "light" and row["value_source_code"] == "asleepCore" and row["value"] is None


def test_project_writer_identity_and_manual_entry(ctx: ProjectContext) -> None:
    res = pre_grove_heart_rate()
    res["extension"][2]["extension"] += [
        {"url": "https://bdh.stanford.edu/fhir/defs/metadata/HKMetadataKeySyncIdentifier", "valueString": "abc-123"},
        {"url": "https://bdh.stanford.edu/fhir/defs/metadata/HKMetadataKeySyncVersion", "valueDecimal": 3},
        {"url": "https://bdh.stanford.edu/fhir/defs/metadata/HKWasUserEntered", "valueDecimal": 1},
    ]
    p = project(parse_observation(res), HR, ctx, 1)
    assert p.row["writer_record_id"].startswith("v0:") and p.row["writer_version"] == "3"
    assert p.row["recording_method"] == "manual-entry"
    half = copy.deepcopy(res)
    half["extension"][2]["extension"].pop(-2)
    p2 = project(parse_observation(half), HR, ctx, 1)
    assert p2.row["writer_record_id"] is None and "writer_half_pair" in p2.warnings


def test_project_warnings(ctx: ProjectContext) -> None:
    res = pre_grove_heart_rate(
        code={
            "coding": [
                {
                    "system": "http://developer.apple.com/documentation/healthkit",
                    "code": "HKQuantityTypeIdentifierStepCount",
                }
            ]
        },
        valueQuantity={"value": 12.5, "unit": "steps"},
    )
    p = project(parse_observation(res), STEPS, ctx, 1)
    assert set(p.warnings) == {"period_expected", "non_integer_value"}


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        (lambda r: r.update(status="preliminary"), "non_final"),
        (lambda r: r.update(resourceType="Procedure"), "not_observation"),
        (lambda r: r.update(id="nope", identifier=[]), "bad_uuid"),
        (lambda r: r.update(effectiveDateTime="2026-08-07T16:03:37"), "bad_time"),
        (lambda r: r.pop("effectiveDateTime"), "missing_effective"),
        (lambda r: r.pop("valueQuantity"), "missing_value"),
        (lambda r: r.update(valueQuantity={"value": "abc", "code": "/min"}), "bad_value"),
        (lambda r: r.update(valueQuantity={"value": 1, "code": "furlong"}), "bad_unit"),
        (
            lambda r: r.update(
                code={
                    "coding": [
                        {
                            "system": "http://developer.apple.com/documentation/healthkit",
                            "code": "HKQuantityTypeIdentifierStepCount",
                        }
                    ]
                }
            ),
            "sample_type_mismatch",
        ),
    ],
)
def test_project_errors(ctx: ProjectContext, mutation, reason: str) -> None:
    res = pre_grove_heart_rate()
    mutation(res)
    with pytest.raises(ProjectError) as exc:
        project(parse_observation(res), HR, ctx, 1)
    assert exc.value.reason == reason


def test_clinical_record_envelope_and_unsupported_type(ctx: ProjectContext) -> None:
    v = parse_observation({"version": "R4", "resource": {"resourceType": "AllergyIntolerance"}})
    assert v.is_clinical_record
    with pytest.raises(ProjectError) as exc:
        project(v, HR, ctx, 1)
    assert exc.value.reason == "clinical_record"
    ecg = REG.get("HKDataTypeIdentifierElectrocardiogram")
    assert ecg
    with pytest.raises(ProjectError) as exc2:
        project(parse_observation(pre_grove_heart_rate(code={"coding": []})), ecg, ctx, 1)
    assert exc2.value.reason == "unsupported_type"


def test_view_grove_shape(ctx: ProjectContext) -> None:
    role = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role"
    res = {
        "resourceType": "Observation",
        "status": "final",
        "identifier": [
            {
                "type": {"coding": [{"system": role, "code": "source-record"}]},
                "system": "https://x/sr",
                "value": "v0:k:1:AAA",
            },
            {
                "type": {"coding": [{"system": role, "code": "source-output"}]},
                "system": "https://x/so",
                "value": "v0:k:1:BBB",
            },
        ],
        "extension": [
            {
                "url": "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-source-type",
                "valueCode": "HKCategoryTypeIdentifierSleepAnalysis",
            },
            {
                "url": "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-recording-method",
                "valueCoding": {"code": "manual-entry"},
            },
        ],
        "effectivePeriod": {
            "start": "2026-09-09T23:00:00+02:00",
            "_start": {
                "extension": [{"url": "http://hl7.org/fhir/StructureDefinition/timezone", "valueCode": "Europe/Berlin"}]
            },
            "end": "2026-09-10T00:30:00+02:00",
        },
        "valueCodeableConcept": {
            "coding": [
                {"system": "https://grovealliance.org/fhir/mobile/CodeSystem/grove-sleep-stage", "code": "deep"},
                {
                    "system": "https://grovealliance.org/fhir/healthkit/CodeSystem/healthkit-sleep-analysis",
                    "code": "asleepDeep",
                },
            ]
        },
    }
    v = parse_observation(res)
    assert v.shape == "grove" and v.sample_type == "HKCategoryTypeIdentifierSleepAnalysis"
    row = project(v, SLEEP, ctx, 1).row
    assert row["sample_id"] == "v0:k:1:BBB" and row["source_record_id"] == "v0:k:1:AAA"
    assert row["value_code"] == "deep" and row["value_source_code"] == "asleepDeep"
    assert row["timezone"] == "Europe/Berlin" and row["recording_method"] == "manual-entry"
