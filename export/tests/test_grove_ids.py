# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
from pathlib import Path

import pytest

from mhc_export.identity.grove_ids import (
    GroveKey,
    HealthKitIdentity,
    IdentityError,
    RepositoryScope,
    canonical_uuid,
    identifier_system,
    opaque_identity,
)

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "grove_identity_vectors.json").read_text())
TEST_KEY = GroveKey(bytes.fromhex(VECTORS["keyHex"]), VECTORS["keyId"], int(VECTORS["epoch"]))


@pytest.mark.parametrize("vector", VECTORS["identities"], ids=[v["id"] for v in VECTORS["identities"]])
def test_normative_vectors(vector: dict) -> None:
    assert opaque_identity(TEST_KEY, vector["identityKind"], vector["components"]) == vector["value"]


def test_test_key_is_detected() -> None:
    assert TEST_KEY.is_test_key
    assert not GroveKey(b"\xff" * 32, "k", 1).is_test_key


def test_component_validation() -> None:
    with pytest.raises(IdentityError):
        opaque_identity(TEST_KEY, "source-record", ["healthkit", "", "s", "v", "id"])
    with pytest.raises(IdentityError):
        opaque_identity(TEST_KEY, "source-record", ["healthkit", "t", "s", "v"])
    with pytest.raises(IdentityError):
        opaque_identity(TEST_KEY, "nope", ["a"])


def test_key_validation() -> None:
    with pytest.raises(IdentityError):
        GroveKey(b"short", "k", 1)
    with pytest.raises(IdentityError):
        GroveKey(b"\x00" * 32, "a:b", 1)
    with pytest.raises(IdentityError):
        GroveKey(b"\x00" * 32, "k", 0)


def test_healthkit_identity_is_deterministic_and_case_insensitive_on_uuid() -> None:
    ident = HealthKitIdentity(TEST_KEY, RepositoryScope("https://x.example/store", "p1"), "https://x.example/fhir")
    upper = ident.source_record("HKQuantityTypeIdentifierHeartRate", "BDAC71F6-3398-4BDD-A56C-7BD50988D87A")
    lower = ident.source_record("HKQuantityTypeIdentifierHeartRate", "bdac71f6-3398-4bdd-a56c-7bd50988d87a")
    assert upper == lower
    assert upper.startswith("v0:test-key:1:") and len(upper.split(":")[-1]) == 43
    out = ident.source_output(
        "HKQuantityTypeIdentifierHeartRate", upper and "BDAC71F6-3398-4BDD-A56C-7BD50988D87A", "heart-rate"
    )
    assert out != upper
    assert ident.system("source-output") == "https://x.example/fhir/NamingSystem/grove-source-output-v0/test-key/1"
    assert identifier_system("https://x.example/fhir/", "source-record", TEST_KEY).endswith(
        "/grove-source-record-v0/test-key/1"
    )


def test_canonical_uuid_rejects_garbage() -> None:
    with pytest.raises(IdentityError):
        canonical_uuid("not-a-uuid")
