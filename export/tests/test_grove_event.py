# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import base64
import copy
import hashlib
import hmac
import json
import re
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from mhc_export.grove import event
from mhc_export.grove.event import (
    REASONS,
    EventConfig,
    EventGraph,
    GroveError,
    RetractionTarget,
    entry_full_url,
    entry_node_value,
    frame,
    parse_event,
)
from mhc_export.io import codec

GROVE = Path(__file__).parent / "fixtures" / "grove"
CFG = EventConfig(
    deployment_root="https://study.example.org/fhir",
    accepted_namespaces=(("test-key", 1),),
    participant_system="https://study.example.org/fhir/identifiers/participant",
)
NS = "https://study.example.org/fhir/NamingSystem"
PPUL = "v0:test-key:1:PPULnf0LKpASjIj8mU5TKafPKig_oqWND3_dHFShGd8"
BYRV = "v0:test-key:1:BYrV6N3A1WrjO1saOCgLww1gdAQqFQ5jLoFoTKwec9c"
M6AF = "v0:test-key:1:M6afafiHPF1Pqyg4OZ5IN0R_8s97oM3WWy904IjTwy8"
SOURCE_RECORD = (f"{NS}/grove-source-record-v0/test-key/1", "v0:test-key:1:ptHr751zWyYfaR2WIvrP1TfnVEK4bInC__ibP_AYfVY")
ROLE_SYSTEM = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role"
LIFECYCLE_SYSTEM = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-lifecycle-event"
ISO_LIFECYCLE = "http://terminology.hl7.org/CodeSystem/iso-21089-lifecycle"
TARGET_ROLE_EXT = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-retraction-target-role"
NATIVE_EXT = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-retraction-target-native-identifier"
RETRACTION_PROVENANCE = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-mobile-retraction-provenance"
RETRACTION_BUNDLE = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-mobile-retraction-bundle"
WORKFLOW_RESEARCH_STUDY = "http://hl7.org/fhir/StructureDefinition/workflow-researchStudy"
PARTICIPANT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type"
HK_DOSE_EVENT = "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-medication-dose-event"
ANDROID_PACKAGE = "https://grovealliance.org/fhir/health-connect/NamingSystem/android-package-name"

OBSERVATION_URL = "urn:uuid:a9b76bbc-f523-5ef4-9919-813ec70553e5"
PATIENT_URL = "urn:uuid:d5137e30-79b1-5110-a09c-bd2528e25085"
DEVICE_URL = "urn:uuid:aef62dba-db7e-5a99-a854-3b5ec312312f"
PROVENANCE_URL = "urn:uuid:71abc484-b9ee-511e-b22a-5b35d026d620"
QUESTIONNAIRE_RESPONSE_URL = "urn:uuid:e516dd51-04d0-502d-abcf-b5c870915c17"


def load(relative: str) -> Any:
    return json.loads((GROVE / relative).read_text())


PROTOCOL = load("exchange-protocol-excerpt.json")
VECTORS = PROTOCOL["testVectors"]
CORPUS = load("mobile-exchange/corpus.json")
BASES = {base["id"]: load(f"mobile-exchange/{base['path']}") for base in CORPUS["bases"]}
CASES = {case["id"]: case for case in CORPUS["cases"]}
ACTIVE = BASES["mobile-exchange"]
RETRACTION = BASES["mobile-retraction"]


def active() -> dict:
    return copy.deepcopy(ACTIVE)


def retraction() -> dict:
    return copy.deepcopy(RETRACTION)


def reason(bundle: Any, cfg: EventConfig = CFG) -> str:
    with pytest.raises(GroveError) as err:
        parse_event(bundle, cfg)
    return err.value.reason


def apply_patch(document: Any, patch: list[dict]) -> Any:
    """RFC 6902 add, remove and replace, which is all the corpus uses."""
    result = copy.deepcopy(document)
    for op in patch:
        *parents, last = [t.replace("~1", "/").replace("~0", "~") for t in op["path"].split("/")[1:]]
        node = result
        for token in parents:
            node = node[int(token)] if isinstance(node, list) else node[token]
        value = copy.deepcopy(op.get("value"))
        match op["op"], isinstance(node, list):
            case "add", True:
                node.insert(len(node) if last == "-" else int(last), value)
            case "remove", True:
                del node[int(last)]
            case "replace", True:
                node[int(last)] = value
            case "add", False:
                node[last] = value
            case "remove", False:
                del node[last]
            case "replace", False:
                assert last in node
                node[last] = value
            case _:
                raise AssertionError(f"unsupported op {op}")
    return result


def rekey(bundle: dict, index: int, role: str, ordinal: int = 0) -> None:
    """Give entry `index` a correctly digested entry-node key for `role` and the matching fullUrl."""
    entry = bundle["entry"][index]
    key = entry["extension"][0]["valueIdentifier"]
    key["value"] = entry_node_value(bundle["identifier"]["system"], bundle["identifier"]["value"], role, ordinal)
    entry["fullUrl"] = entry_full_url(key["system"], key["value"])


# Protocol test vectors


def test_frame_layout() -> None:
    assert frame([]) == b""
    assert frame(["a", "é", ""]) == b"\x00\x00\x00\x01a\x00\x00\x00\x02\xc3\xa9\x00\x00\x00\x00"


@pytest.mark.parametrize("vector", VECTORS["identities"], ids=[v["id"] for v in VECTORS["identities"]])
def test_frame_reproduces_identity_preimages(vector: dict) -> None:
    key = bytes.fromhex(VECTORS["keyHex"])
    preimage = frame(["org.grovealliance.fhir.identity.v0", vector["identityKind"], *vector["components"]])
    digest = hmac.new(key, preimage, hashlib.sha256).digest()
    encoded = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    assert f"v0:{VECTORS['keyId']}:{VECTORS['epoch']}:{encoded}" == vector["value"]


def test_entry_node_vector() -> None:
    node, ev = VECTORS["entryNode"], VECTORS["event"]
    assert ev["value"] == f"e0:{ev['producerInstance']}:{ev['sequence']}"
    value = entry_node_value(ev["system"], ev["value"], node["role"], int(node["ordinal"]))
    assert value == node["value"]
    assert entry_full_url(node["system"], value) == node["fullUrl"]


@pytest.mark.parametrize("vector", VECTORS["fullUrls"], ids=[v["id"] for v in VECTORS["fullUrls"]])
def test_full_url_vectors(vector: dict) -> None:
    assert entry_full_url(vector["system"], vector["value"]) == vector["fullUrl"]


def test_full_url_is_hashed_over_framed_bytes() -> None:
    url = entry_full_url(VECTORS["fullUrls"][0]["system"], VECTORS["fullUrls"][0]["value"])
    parsed = uuid.UUID(url.removeprefix("urn:uuid:"))
    assert (parsed.version, parsed.variant) == (5, uuid.RFC_4122)
    framed = frame([VECTORS["fullUrls"][0]["system"], VECTORS["fullUrls"][0]["value"]]).decode("latin-1")
    assert url != f"urn:uuid:{uuid.uuid5(uuid.UUID('43df4575-bff7-5a57-9a80-2472cd2b0623'), framed)}"


# Valid fixtures


def test_exchange_bundle_is_an_active_event() -> None:
    graph = parse_event(ACTIVE, CFG)
    assert isinstance(graph, EventGraph)
    assert graph.kind == "active"
    assert (graph.event_system, graph.event_value) == (
        f"{NS}/grove-event-v0",
        "e0:1f5c58aa-6ec6-4e79-a682-829a9debd3f5:42",
    )
    assert graph.timestamp == "2026-08-20T17:30:02Z"
    assert [r["resourceType"] for r in graph.entries.values()] == [
        "Patient",
        "Device",
        "Observation",
        "Provenance",
        "QuestionnaireResponse",
    ]
    assert [e["fullUrl"] for e in ACTIVE["entry"]] == list(graph.entries)
    assert graph.outputs == [graph.entries[OBSERVATION_URL]]
    assert graph.provenance is graph.entries[PROVENANCE_URL]
    assert graph.source_record == SOURCE_RECORD
    assert graph.targets == []


def test_retraction_bundle_is_a_retraction() -> None:
    graph = parse_event(RETRACTION, CFG)
    assert graph.kind == "retraction"
    assert graph.event_value == "e0:1f5c58aa-6ec6-4e79-a682-829a9debd3f5:43"
    assert graph.outputs == []
    assert graph.provenance["id"] == "GroveMobileRetractionProvenanceExample"
    assert graph.source_record == SOURCE_RECORD
    assert graph.targets == [
        RetractionTarget(
            role="primary-output",
            resource_type="Observation",
            identifier_role="source-output",
            system=f"{NS}/grove-source-output-v0/test-key/1",
            value=PPUL,
            native_system=f"{NS}/native-record/health-connect/1f5c58aa-6ec6-4e79-a682-829a9debd3f5",
            native_value="record-heart-001",
        )
    ]


def test_parse_event_does_not_mutate_its_input() -> None:
    before = active()
    parse_event(before, CFG)
    assert before == ACTIVE


RECEIVER_OUTPUTS = {
    "altered-retry.json": [PPUL],
    "changed-source-record.json": [PPUL],
    "corrected.json": [PPUL],
    "lexeme-retry.json": [PPUL],
    "multi-v1.json": [PPUL, BYRV],
    "multi-v2.json": [PPUL],
    "multi-v3.json": [PPUL, BYRV],
    "original.json": [PPUL],
    "other-writer.json": [PPUL],
    "pending.json": [PPUL],
    "target.json": [M6AF],
    "unordered-a.json": [PPUL],
    "unordered-b.json": [PPUL],
}


def output_ids(graph: EventGraph) -> list[str]:
    return [
        i["value"]
        for o in graph.outputs
        for i in o["identifier"]
        if i.get("type", {}).get("coding", [{}])[0].get("code") == "source-output"
    ]


def test_every_receiver_fixture_is_classified() -> None:
    names = {p.name for p in (GROVE / "receiver-lifecycle").glob("*.json")}
    assert names == RECEIVER_OUTPUTS.keys() | {"retraction.json"}


@pytest.mark.parametrize("name", sorted(RECEIVER_OUTPUTS))
def test_receiver_lifecycle_active_events_parse(name: str) -> None:
    graph = parse_event(load(f"receiver-lifecycle/{name}"), CFG)
    assert graph.kind == "active"
    assert output_ids(graph) == RECEIVER_OUTPUTS[name]


def test_receiver_lifecycle_retraction_matches_the_corpus_base() -> None:
    graph = parse_event(load("receiver-lifecycle/retraction.json"), CFG)
    assert graph.kind == "retraction"
    assert [t.value for t in graph.targets] == [PPUL]


def test_pending_logical_derived_from_is_not_resolved() -> None:
    graph = parse_event(load("receiver-lifecycle/pending.json"), CFG)
    (observation,) = graph.outputs
    (derived,) = observation["derivedFrom"]
    assert "reference" not in derived
    assert graph.resolve(derived, {"QuestionnaireResponse"}) is None


@pytest.mark.parametrize(("name", "versions"), [("source-event.json", {"1"}), ("context-two-studies.json", {"1", "3"})])
def test_study_attribution_resolves_the_protocol_chain(name: str, versions: set[str]) -> None:
    graph = parse_event(load(f"study-attribution/{name}"), CFG)
    (observation,) = graph.outputs
    found = set()
    for ext in observation["extension"]:
        if ext["url"] == WORKFLOW_RESEARCH_STUDY:
            study = graph.resolve(ext["valueReference"], {"ResearchStudy"})
            assert study is not None
            for protocol in study["protocol"]:
                plan = graph.resolve(protocol, {"PlanDefinition"})
                assert plan is not None
                found.add(plan["version"])
    assert found == versions
    assert [r["resourceType"] for r in graph.entries.values()].count("ResearchSubject") == len(versions)


def test_control_observation_is_not_a_bundle() -> None:
    assert reason(load("profile-invariants/control.json")) == "grove_not_bundle"


@pytest.mark.parametrize("element", [None, [], "Bundle", 7, {"resourceType": "Observation"}, {"entry": []}])
def test_non_bundle_elements_are_rejected(element: Any) -> None:
    assert reason(element) == "grove_not_bundle"


# Negative corpus

STRUCTURAL = {
    "missing-entry-node-key": "grove_entry_key",
    "tampered-entry-node-digest": "grove_entry_key",
    "misnumbered-entry-node-ordinal": "grove_entry_key",
    "repeated-entry-key": "grove_entry_key",
    "lower-priority-entry-key": "grove_entry_key",
    "non-canonical-entry-node-key": "grove_entry_key",
    "non-deterministic-full-url": "grove_full_url",
    "unresolved-internal-reference": "grove_unresolved_reference",
    "wrong-subject-target-type": "grove_reference_target_type",
    "questionnaire-response-subject-wrong-target": "grove_reference_target_type",
    "false-reference-declared-type": "grove_reference_type",
    "mixed-literal-logical-patient-reference": "grove_reference_shape",
    "untyped-logical-patient-reference": "grove_reference_shape",
    "questionnaire-response-subject-reserved-system": "grove_reference_shape",
    "questionnaire-response-subject-grove-role": "grove_reference_shape",
    "non-canonical-event-identity": "grove_event_identity",
    "event-identifier-with-two-roles": "grove_event_identity",
    "both-exchange-profiles-claimed": "grove_bundle_profile",
    "empty-entry-list": "grove_empty_bundle",
    "repeated-identifier-role-coding": "grove_identifier_role",
    "identity-system-changes-role": "grove_identifier_role",
    "clear-source-record-identity": "bad_grove_identity",
    "repeated-source-record-identifier": "duplicate_grove_identity",
    "missing-source-output-identity": "missing_grove_identity",
    "missing-transform-provenance": "grove_lifecycle",
    "ambiguous-active-lifecycle-coding": "grove_lifecycle",
    "contradictory-retraction-lifecycle-coding": "grove_lifecycle",
    "retraction-with-transform-activity": "grove_lifecycle",
    "unadmitted-condition-resource": "grove_entry_resource_type",
    "unadmitted-device-metric-resource": "grove_entry_resource_type",
    "contained-resource-prohibited": "grove_contained",
    "active-event-without-output": "grove_no_output",
    "transform-provenance-without-target": "grove_provenance_targets",
    "transform-literal-source-entity": "grove_source_entity",
    "retraction-additional-source-entity": "grove_source_entity",
    "unprofiled-active-observation": "grove_profile",
    "unprofiled-active-device": "grove_profile",
    "unprofiled-active-provenance": "grove_profile",
    "disconnected-supporting-patient": "grove_disconnected",
    "retraction-literal-target": "grove_retraction_literal_target",
    "retraction-unknown-target-role": "grove_retraction_target_role",
    "retraction-clear-target-identity": "bad_grove_identity",
    "retraction-copied-clinical-resource": "grove_retraction_clinical_copy",
    "retraction-role-target-type-mismatch": "grove_retraction_role_type",
    "retraction-native-identifier-uses-grove-role": "grove_retraction_native_identifier",
    "retraction-without-target": "grove_retraction_no_target",
    "repeated-retraction-target": "grove_retraction_duplicate_target",
}

# Cases the spec assigns to the HealthKit projection or to content rules. None means parse_event accepts the event.
NOT_STRUCTURAL: dict[str, str | None] = {
    # Fixed quantity unit is a measurement-content rule; the projection drops the row as non-fatal bad_unit.
    "wrong-heart-rate-unit": None,
    # A SensorKit conversion Provenance is an admitted profile; the HealthKit layer rejects it as grove_not_healthkit.
    "adapter-provenance-without-adapter-output": None,
    # A Health Connect conversion Provenance is an admitted profile; the HealthKit layer rejects it as grove_not_healthkit.
    "health-connect-provenance-without-data-origin": None,
    # Source-type markers are adapter claims; the HealthKit layer rejects the Mobile Provenance as grove_not_healthkit.
    "source-marker-on-source-neutral-output": None,
    # Attachment integrity is a sensor-recording-document rule; the HealthKit layer rejects it as grove_not_healthkit.
    "tampered-embedded-recording-hash": None,
    # The recording-format registry is a sensor-recording-document rule; rejected as grove_not_healthkit.
    "unregistered-recording-format": None,
    # Listed as HealthKit-only, but the adapter-only output profile claim is enforced structurally.
    "adapter-only-output-without-adapter-profile": "grove_profile",
    # Listed as HealthKit-only, but every active output must claim a profile structurally.
    "unprofiled-active-document-reference": "grove_profile",
}


def test_corpus_is_fully_classified() -> None:
    assert len(CASES) == 55
    assert STRUCTURAL.keys() | NOT_STRUCTURAL.keys() == CASES.keys()
    assert not STRUCTURAL.keys() & NOT_STRUCTURAL.keys()


@pytest.mark.parametrize("case_id", sorted(CASES))
def test_corpus_patch_changes_its_base(case_id: str) -> None:
    case = CASES[case_id]
    assert apply_patch(BASES[case["base"]], case["patch"]) != BASES[case["base"]]


@pytest.mark.parametrize("case_id", sorted(STRUCTURAL))
def test_corpus_case_fails_with_its_reason(case_id: str) -> None:
    case = CASES[case_id]
    assert reason(apply_patch(BASES[case["base"]], case["patch"])) == STRUCTURAL[case_id]


@pytest.mark.parametrize("case_id", sorted(NOT_STRUCTURAL))
def test_corpus_case_outside_the_envelope(case_id: str) -> None:
    case = CASES[case_id]
    bundle = apply_patch(BASES[case["base"]], case["patch"])
    expected = NOT_STRUCTURAL[case_id]
    if expected is None:
        assert parse_event(bundle, CFG).kind == "active"
    else:
        assert reason(bundle) == expected


# Retraction recognition


def test_foreign_retracted_coding_does_not_make_an_active_event_a_retraction() -> None:
    bundle = active()
    bundle["entry"][3]["resource"]["activity"]["coding"].append(
        {"system": "https://example.org/lifecycle", "code": "source-record-retracted"}
    )
    graph = parse_event(bundle, CFG)
    assert graph.kind == "active"
    assert len(graph.outputs) == 1
    assert graph.targets == []


def test_grove_retracted_coding_on_an_active_event_is_fatal() -> None:
    bundle = active()
    bundle["entry"][3]["resource"]["activity"]["coding"].append(
        {"system": LIFECYCLE_SYSTEM, "code": "source-record-retracted"}
    )
    assert reason(bundle) == "grove_lifecycle"


def test_retraction_with_an_added_transform_coding_is_fatal() -> None:
    bundle = retraction()
    bundle["entry"][0]["resource"]["activity"]["coding"].append({"system": ISO_LIFECYCLE, "code": "transform"})
    assert reason(bundle) == "grove_lifecycle"


def test_retraction_keeps_foreign_translations() -> None:
    bundle = retraction()
    bundle["entry"][0]["resource"]["activity"]["coding"].append({"system": "https://example.org/x", "code": "deleted"})
    assert parse_event(bundle, CFG).kind == "retraction"


@pytest.mark.parametrize(
    "literal", [OBSERVATION_URL, "urn:uuid:f99194b8-aaf8-5fdb-91fa-19309bdd6716", "#prior", "Observation/1"]
)
def test_retraction_target_with_a_literal_reference_is_fatal(literal: str) -> None:
    bundle = retraction()
    bundle["entry"][0]["resource"]["target"][0]["reference"] = literal
    assert reason(bundle) == "grove_retraction_literal_target"


def test_retraction_profile_over_an_active_payload_is_fatal() -> None:
    bundle = active()
    bundle["meta"]["profile"] = [RETRACTION_BUNDLE]
    assert reason(bundle) == "grove_retraction_clinical_copy"


def test_retraction_provenance_must_claim_the_retraction_profile() -> None:
    bundle = retraction()
    bundle["entry"][0]["resource"]["meta"]["profile"] = [
        "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-mobile-conversion-provenance"
    ]
    assert reason(bundle) == "grove_profile"


def test_retraction_provenance_must_use_the_retraction_node_role() -> None:
    bundle = retraction()
    rekey(bundle, 0, "conversion-provenance")
    assert reason(bundle) == "grove_entry_key"


def test_active_provenance_must_use_the_conversion_node_role() -> None:
    bundle = active()
    rekey(bundle, 3, "retraction-provenance")
    assert reason(bundle) == "grove_entry_key"


def test_entry_node_role_must_fit_the_resource() -> None:
    bundle = active()
    rekey(bundle, 4, "plan-definition")
    assert reason(bundle) == "grove_entry_key"


def device_snapshot_target(value: str = "v0:test-key:1:JUZooa4NZX-rlMn9-NC8W078xzEuUO9X3Xo1mgk0Vac") -> dict:
    return {
        "extension": [{"url": TARGET_ROLE_EXT, "valueCode": "device-snapshot"}],
        "type": "Device",
        "identifier": {
            "type": {"coding": [{"system": ROLE_SYSTEM, "code": "device-snapshot"}]},
            "system": f"{NS}/grove-device-snapshot-v0/test-key/1",
            "value": value,
        },
    }


def test_every_retraction_target_is_extracted() -> None:
    bundle = retraction()
    bundle["entry"][0]["resource"]["target"].append(device_snapshot_target())
    graph = parse_event(bundle, CFG)
    assert [(t.role, t.resource_type, t.identifier_role) for t in graph.targets] == [
        ("primary-output", "Observation", "source-output"),
        ("device-snapshot", "Device", "device-snapshot"),
    ]
    assert graph.targets[1].native_system is None and graph.targets[1].native_value is None


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda t: t.pop("type"), "grove_retraction_role_type"),
        (lambda t: t.update(type="DocumentReference"), "grove_retraction_role_type"),
        (
            lambda t: t["identifier"]["type"]["coding"].__setitem__(
                0, {"system": ROLE_SYSTEM, "code": "device-snapshot"}
            ),
            "grove_retraction_role_type",
        ),
        (
            lambda t: t["identifier"]["type"]["coding"].append({"system": ROLE_SYSTEM, "code": "source-output"}),
            "grove_identifier_role",
        ),
        (lambda t: t.pop("identifier"), "bad_grove_identity"),
        (lambda t: t["extension"].pop(0), "grove_retraction_target_role"),
        (
            lambda t: t["extension"].append({"url": TARGET_ROLE_EXT, "valueCode": "child-output"}),
            "grove_retraction_target_role",
        ),
        (lambda t: t["extension"].append(copy.deepcopy(t["extension"][1])), "grove_retraction_native_identifier"),
        (lambda t: t["extension"][1]["valueIdentifier"].pop("value"), "grove_retraction_native_identifier"),
        (
            lambda t: t["extension"][1]["valueIdentifier"].update(system="not a uri"),
            "grove_retraction_native_identifier",
        ),
        (lambda t: t["identifier"].update(system=f"{NS}/grove-source-output-v0/other-key/1"), "foreign_identity"),
        (lambda t: t["identifier"].update(value=PPUL.replace("test-key", "other-key")), "foreign_identity"),
    ],
)
def test_retraction_target_rules(mutate: Any, expected: str) -> None:
    bundle = retraction()
    mutate(bundle["entry"][0]["resource"]["target"][0])
    assert reason(bundle) == expected


def test_child_output_target_is_accepted() -> None:
    bundle = retraction()
    bundle["entry"][0]["resource"]["target"][0]["extension"][0]["valueCode"] = "child-output"
    assert parse_event(bundle, CFG).targets[0].role == "child-output"


# Envelope rules beyond the corpus


def test_mhc_deployment_root_rejects_fixture_identities() -> None:
    cfg = EventConfig(
        "https://myheartcounts.stanford.edu/fhir", (("store", 1), ("test-key", 1)), CFG.participant_system
    )
    assert reason(ACTIVE, cfg) == "foreign_identity"
    assert reason(RETRACTION, cfg) == "foreign_identity"


@pytest.mark.parametrize("namespaces", [(), (("store", 1),), (("test-key", 2),)])
def test_unaccepted_namespace_is_foreign(namespaces: tuple) -> None:
    cfg = EventConfig(CFG.deployment_root, namespaces, CFG.participant_system)
    assert reason(ACTIVE, cfg) == "foreign_identity"
    assert reason(RETRACTION, cfg) == "foreign_identity"


def test_identity_system_must_name_role_key_and_epoch() -> None:
    bundle = active()
    bundle["entry"][2]["resource"]["identifier"][1]["system"] = f"{NS}/grove-source-output-v0/test-key/2"
    assert reason(bundle) == "foreign_identity"


def test_resource_identifiers_carry_only_opaque_roles() -> None:
    bundle = active()
    bundle["entry"][2]["resource"]["identifier"][0]["type"]["coding"][0]["code"] = "entry-node"
    assert reason(bundle) == "grove_identifier_role"


def test_event_identity_system_is_deployment_scoped() -> None:
    bundle = active()
    bundle["identifier"]["system"] = "https://other.example.org/fhir/NamingSystem/grove-event-v0"
    assert reason(bundle) == "foreign_identity"


@pytest.mark.parametrize(
    ("mutate", "expected"),
    [
        (lambda b: b.update(type="transaction"), "grove_bundle_shape"),
        (lambda b: b.pop("timestamp"), "grove_bundle_shape"),
        (lambda b: b["meta"].update(profile=[]), "grove_bundle_profile"),
        (lambda b: b.pop("entry"), "grove_empty_bundle"),
        (lambda b: b.pop("identifier"), "grove_event_identity"),
        (lambda b: b["entry"][0].update(request={"method": "POST", "url": "Patient"}), "grove_entry_shape"),
        (lambda b: b["entry"][0].pop("resource"), "grove_entry_shape"),
        (lambda b: b["entry"][0].update(extension=b["entry"][0]["extension"] * 2), "grove_entry_key"),
        (lambda b: b["entry"][0]["extension"][0]["valueIdentifier"].update(system=f"{NS}/other-v0"), "grove_entry_key"),
        (lambda b: b["entry"][2]["resource"]["identifier"].pop(0), "missing_grove_identity"),
        (lambda b: b["entry"][1]["resource"]["meta"].update(profile=["https://example.org/device"]), "grove_profile"),
        (lambda b: b["entry"][4]["resource"].pop("meta"), "grove_profile"),
        (lambda b: b["entry"][2]["resource"]["subject"].update(reference="Patient/1"), "grove_unresolved_reference"),
        (lambda b: b["entry"][2]["resource"].update(device={"reference": PATIENT_URL}), "grove_reference_target_type"),
        (lambda b: b["entry"][2]["resource"].update(derivedFrom={"reference": PATIENT_URL}), "grove_reference_shape"),
        (
            lambda b: b["entry"][2]["resource"]["extension"][0]["valueReference"].update(reference=PATIENT_URL),
            "grove_reference_target_type",
        ),
        (lambda b: b["entry"][3]["resource"].pop("agent"), "grove_provenance_agent"),
        (
            lambda b: b["entry"][3]["resource"]["agent"][0]["who"].update(reference=PATIENT_URL),
            "grove_provenance_agent",
        ),
        (lambda b: b["entry"][3]["resource"].pop("recorded"), "grove_provenance_recorded"),
        (lambda b: b["entry"][3]["resource"].pop("occurredDateTime"), "grove_provenance_occurred"),
        (lambda b: b["entry"][3]["resource"]["entity"][0].update(role="derivation"), "grove_source_entity"),
        (
            lambda b: b["entry"][3]["resource"]["entity"][0]["what"]["identifier"].update(value="record-heart-001"),
            "bad_grove_identity",
        ),
        (
            lambda b: b["entry"][3]["resource"]["target"].append({"reference": OBSERVATION_URL}),
            "grove_provenance_targets",
        ),
        (lambda b: b["entry"][3]["resource"]["target"].append({"reference": PATIENT_URL}), "grove_provenance_targets"),
    ],
)
def test_envelope_rules(mutate: Any, expected: str) -> None:
    bundle = active()
    mutate(bundle)
    assert reason(bundle) == expected


def test_outputs_share_the_provenance_source_record() -> None:
    bundle = active()
    bundle["entry"][3]["resource"]["entity"][0]["what"]["identifier"]["value"] = (
        "v0:test-key:1:WssrtI7oYzcgG0mFxlitvSznCx4esKSDEbK-bOUQpTk"
    )
    assert reason(bundle) == "grove_source_record_mismatch"


def test_logical_device_assembler_is_accepted_without_resolution() -> None:
    graph = parse_event(RETRACTION, CFG)
    who = graph.provenance["agent"][0]["who"]
    assert graph.resolve(who, {"Device"}) is None


@pytest.mark.parametrize(
    "profile",
    [[None], [""], [7], [{}], ["|5.3.0"], ["https://example.org/p", "https://example.org/p"], "https://example.org/p"],
)
def test_active_output_profile_claims_are_distinct_non_empty_strings(profile: Any) -> None:
    observation = active()
    observation["entry"][2]["resource"]["meta"]["profile"] = profile
    document = apply_patch(ACTIVE, CASES["unprofiled-active-document-reference"]["patch"])
    document["entry"][2]["resource"]["meta"] = {"profile": profile}
    assert reason(observation) == "grove_profile"
    assert reason(document) == "grove_profile"


MIXED_IDENTIFIER = {"system": "https://x.example/ids", "value": "1"}


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r[3]["entity"][0].update(agent=[{"who": {"reference": DEVICE_URL, "identifier": MIXED_IDENTIFIER}}]),
        lambda r: r[3]["agent"][0]["who"].update(identifier=MIXED_IDENTIFIER),
        lambda r: r[2]["performer"][0].update(identifier=MIXED_IDENTIFIER),
        lambda r: r[2]["identifier"][0].update(assigner={"reference": PATIENT_URL, "identifier": MIXED_IDENTIFIER}),
    ],
    ids=["entity-agent", "assembler", "performer", "identifier-assigner"],
)
def test_reference_mixing_literal_and_identifier_is_rejected_off_governed_paths(mutate: Any) -> None:
    bundle = active()
    mutate([entry["resource"] for entry in bundle["entry"]])
    assert reason(bundle) == "grove_reference_shape"


@pytest.mark.parametrize(
    "ref",
    [
        {"identifier": {"system": "not a uri", "value": ""}},
        {"identifier": {"system": "https://x.example/ids", "value": ""}},
        {"identifier": {"value": "1"}},
        {"identifier": "1"},
        {"type": "Patient", "identifier": {"system": ROLE_SYSTEM, "value": "x"}},
        {
            "type": "Patient",
            "identifier": {
                "type": {"coding": [{"system": ROLE_SYSTEM, "code": "source-record"}]},
                "system": "https://x.example/ids",
                "value": "x",
            },
        },
    ],
)
def test_identifier_only_reference_off_governed_paths_needs_a_complete_identifier(ref: dict) -> None:
    based_on, performer = active(), active()
    based_on["entry"][2]["resource"]["basedOn"] = [ref]
    performer["entry"][2]["resource"]["performer"] = [ref]
    assert reason(based_on) == "grove_reference_shape"
    assert reason(performer) == "grove_reference_shape"


def test_healthkit_untyped_identifier_only_medication_reference_is_accepted() -> None:
    bundle = active()
    observation = bundle["entry"][2]["resource"]
    bundle["entry"][2]["resource"] = {
        "resourceType": "MedicationAdministration",
        "meta": {"profile": [HK_DOSE_EVENT]},
        "identifier": observation["identifier"],
        "status": "completed",
        "medicationReference": {
            "identifier": {
                "type": {"coding": [{"system": ROLE_SYSTEM, "code": "source-context"}]},
                "system": f"{NS}/grove-source-context-v0/test-key/1",
                "value": "v0:test-key:1:yGgoW6BXR_wT7vPwUpVQz6UsHq7NLUDE70Ocog4kKtw",
            }
        },
        "subject": observation["subject"],
        "supportingInformation": [{"reference": QUESTIONNAIRE_RESPONSE_URL}],
        "effectivePeriod": {"start": "2026-08-20T21:07:12-07:00", "end": "2026-08-20T21:07:12-07:00"},
    }
    graph = parse_event(bundle, CFG)
    assert [o["resourceType"] for o in graph.outputs] == ["MedicationAdministration"]


def test_health_connect_identifier_only_enterer_is_accepted() -> None:
    bundle = active()
    bundle["entry"][3]["resource"]["entity"][0]["agent"] = [
        {
            "type": {"coding": [{"system": PARTICIPANT_TYPE, "code": "enterer"}]},
            "who": {"type": "Device", "identifier": {"system": ANDROID_PACKAGE, "value": "com.example.wearable"}},
        }
    ]
    assert parse_event(bundle, CFG).kind == "active"


OVERLONG_EPOCH = "v0:test-key:" + "1" * 4301 + ":" + "A" * 43


@pytest.mark.parametrize(
    ("base_id", "mutate"),
    [
        ("mobile-exchange", lambda b: b["entry"][2]["resource"]["identifier"][1].update(value=OVERLONG_EPOCH)),
        (
            "mobile-exchange",
            lambda b: b["entry"][3]["resource"]["entity"][0]["what"]["identifier"].update(value=OVERLONG_EPOCH),
        ),
        (
            "mobile-retraction",
            lambda b: b["entry"][0]["resource"]["target"][0]["identifier"].update(value=OVERLONG_EPOCH),
        ),
    ],
    ids=["resource-identifier", "source-entity", "retraction-target"],
)
def test_overlong_epoch_is_a_foreign_identity(base_id: str, mutate: Any) -> None:
    bundle = copy.deepcopy(BASES[base_id])
    mutate(bundle)
    assert reason(bundle) == "foreign_identity"


def test_nesting_up_to_the_decoder_limit_is_walked_without_recursion() -> None:
    bundle = active()
    bundle["entry"][2]["resource"]["note"] = "@"
    blob = json.dumps([bundle]).replace('"@"', "[" * 1010 + "]" * 1010).encode()
    (decoded,) = codec.decode(blob)
    assert parse_event(decoded, CFG).kind == "active"


@pytest.mark.parametrize(("base_id", "index"), [("mobile-exchange", 3), ("mobile-retraction", 0)])
@pytest.mark.parametrize("typed", [True, False])
def test_provenance_cannot_be_keyed_by_an_identifier(base_id: str, index: int, typed: bool) -> None:
    bundle = copy.deepcopy(BASES[base_id])
    entry = bundle["entry"][index]
    identifier = copy.deepcopy(entry["resource"]["entity"][0]["what"]["identifier"])
    if not typed:
        identifier.pop("type")
    entry["resource"]["identifier"] = [identifier]
    if typed:
        entry["extension"][0]["valueIdentifier"] = copy.deepcopy(identifier)
        entry["fullUrl"] = entry_full_url(identifier["system"], identifier["value"])
    assert reason(bundle) == "grove_entry_key"


# resolve()


@pytest.fixture(scope="module")
def graph() -> EventGraph:
    return parse_event(ACTIVE, CFG)


def test_resolve_literal_and_logical(graph: EventGraph) -> None:
    observation = graph.outputs[0]
    assert graph.resolve(observation["subject"], {"Patient"}) is graph.entries[PATIENT_URL]
    assert graph.resolve(None, {"Patient"}) is None
    logical = {"type": "Patient", "identifier": {"system": CFG.participant_system, "value": "participant-001"}}
    assert graph.resolve(logical, {"Patient"}) is None


@pytest.mark.parametrize(
    ("ref", "allowed", "expected"),
    [
        ({"reference": PATIENT_URL}, {"Device"}, "grove_reference_target_type"),
        ({"reference": PATIENT_URL, "type": "Device"}, {"Patient", "Device"}, "grove_reference_type"),
        ({"reference": "urn:uuid:00000000-0000-5000-8000-000000000000"}, {"Patient"}, "grove_unresolved_reference"),
        ({"reference": "Patient/1"}, {"Patient"}, "grove_unresolved_reference"),
        (
            {"reference": PATIENT_URL, "identifier": {"system": "https://x.org", "value": "1"}},
            {"Patient"},
            "grove_reference_shape",
        ),
        ({"identifier": {"system": "https://x.org", "value": "1"}}, {"Patient"}, "grove_reference_shape"),
        (
            {"type": "Device", "identifier": {"system": "https://x.org", "value": "1"}},
            {"Patient"},
            "grove_reference_shape",
        ),
        ({"type": "Patient", "identifier": {"system": "urn", "value": "1"}}, {"Patient"}, "grove_reference_shape"),
        (
            {"type": "Patient", "identifier": {"system": ROLE_SYSTEM, "value": "1"}},
            {"Patient"},
            "grove_reference_shape",
        ),
        ({"display": "someone"}, {"Patient"}, "grove_reference_shape"),
        ("urn:uuid:x", {"Patient"}, "grove_reference_shape"),
    ],
)
def test_resolve_rejects(graph: EventGraph, ref: Any, allowed: set[str], expected: str) -> None:
    with pytest.raises(GroveError) as err:
        graph.resolve(ref, allowed)
    assert err.value.reason == expected


# Robustness: malformed input fails as a GroveError, never as a crash.


def json_paths(node: Any, path: tuple = ()) -> Iterator[tuple]:
    yield path
    if isinstance(node, dict):
        for key, child in node.items():
            yield from json_paths(child, (*path, key))
    elif isinstance(node, list):
        for index, child in enumerate(node):
            yield from json_paths(child, (*path, index))


def mutations(base: dict) -> Iterator[Any]:
    for path in list(json_paths(base))[1:]:
        for replacement in (None, 7, "x", [], {}, [[]], {"a": []}):
            doc = copy.deepcopy(base)
            parent = doc
            for step in path[:-1]:
                parent = parent[step]
            if replacement is None:
                del parent[path[-1]]
            else:
                parent[path[-1]] = replacement
            yield doc


@pytest.mark.parametrize("base_id", sorted(BASES))
def test_malformed_events_raise_grove_errors(base_id: str) -> None:
    for doc in mutations(BASES[base_id]):
        try:
            parse_event(doc, CFG)
        except GroveError as err:
            assert err.reason in REASONS


def test_grove_error_is_a_value_error_with_a_reason() -> None:
    err = GroveError("grove_entry_key", "boom")
    assert isinstance(err, ValueError)
    assert err.reason == "grove_entry_key"
    assert "boom" in str(err)


def test_reasons_match_the_module() -> None:
    source = Path(event.__file__).read_text()
    assert set(re.findall(r'GroveError\(\s*"([a-z_]+)"', source)) == REASONS
    used = set(STRUCTURAL.values()) | {r for r in NOT_STRUCTURAL.values() if r}
    assert used <= REASONS
