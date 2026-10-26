# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import pytest

from mhc_export.identity.grove_ids import GroveKey, HealthKitIdentity, RepositoryScope
from mhc_export.run.models import UploadKind
from mhc_export.transform.project import ProjectContext

TEST_KEY = GroveKey(bytes(range(32)), "test-key", 1)
SCOPE = RepositoryScope("https://mhc.example/fhir/NamingSystem/healthkit-store", "participant-0001")


@pytest.fixture
def identity() -> HealthKitIdentity:
    return HealthKitIdentity(TEST_KEY, SCOPE, "https://mhc.example/fhir")


@pytest.fixture
def ctx(identity: HealthKitIdentity) -> ProjectContext:
    return ProjectContext("participant-0001", identity, "r-test", UploadKind.LIVE, True)


def bdh(url: str, **values: object) -> dict:
    return {"url": url, **values}


def pre_grove_heart_rate(**overrides: object) -> dict:
    base = {
        "resourceType": "Observation",
        "id": "BDAC71F6-3398-4BDD-A56C-7BD50988D87A",
        "identifier": [{"id": "BDAC71F6-3398-4BDD-A56C-7BD50988D87A"}],
        "status": "final",
        "code": {
            "coding": [
                {"system": "http://loinc.org", "code": "8867-4"},
                {
                    "system": "http://developer.apple.com/documentation/healthkit",
                    "code": "HKQuantityTypeIdentifierHeartRate",
                },
            ]
        },
        "effectiveDateTime": "2026-08-07T16:03:37.797878384-07:00",
        "issued": "2026-08-07T16:04:59.340883016-07:00",
        "valueQuantity": {"value": 84, "unit": "beats/minute", "code": "/min", "system": "http://unitsofmeasure.org"},
        "extension": [
            {
                "url": "https://bdh.stanford.edu/fhir/defs/sourceDevice",
                "extension": [
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceDevice/name", valueString="Apple Watch"),
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceDevice/manufacturer", valueString="Apple Inc."),
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceDevice/model", valueString="Watch"),
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceDevice/hardwareVersion", valueString="Watch7,12"),
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceDevice/softwareVersion", valueString="26.5"),
                ],
            },
            {
                "url": "https://bdh.stanford.edu/fhir/defs/sourceRevision",
                "extension": [
                    {
                        "url": "https://bdh.stanford.edu/fhir/defs/sourceRevision/source",
                        "extension": [
                            bdh(
                                "https://bdh.stanford.edu/fhir/defs/sourceRevision/source/name",
                                valueString="Lukas' Apple Watch",
                            ),
                            bdh(
                                "https://bdh.stanford.edu/fhir/defs/sourceRevision/source/bundleIdentifier",
                                valueString="com.apple.health.B83FE7C9-B62D-44D9-92A8-5CB2AE037A06",
                            ),
                        ],
                    },
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceRevision/version", valueString="31.2"),
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceRevision/productType", valueString="Watch7,12"),
                    bdh("https://bdh.stanford.edu/fhir/defs/sourceRevision/OSVersion", valueString="26.5.0"),
                ],
            },
            {
                "url": "https://bdh.stanford.edu/fhir/defs/metadata",
                "extension": [
                    bdh(
                        "https://bdh.stanford.edu/fhir/defs/metadata/HKMetadataKeyHeartRateMotionContext",
                        valueCoding={"code": "1", "display": "sedentary", "system": "x"},
                    )
                ],
            },
            bdh("https://bdh.stanford.edu/fhir/defs/sampleUploadTimeZone", valueString="America/Los_Angeles"),
            {
                "url": "https://myheartcounts.stanford.edu/fhir/StructureDefinition/study-enrollment",
                "extension": [
                    bdh(
                        "https://myheartcounts.stanford.edu/fhir/StructureDefinition/study-enrollment/study-id",
                        valueString="5D46",
                    ),
                    bdh(
                        "https://myheartcounts.stanford.edu/fhir/StructureDefinition/study-enrollment/study-revision",
                        valueInteger=42,
                    ),
                ],
            },
        ],
    }
    base.update(overrides)
    return base
