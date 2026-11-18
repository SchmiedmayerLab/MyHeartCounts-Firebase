# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Source-neutral structural validation of one Grove 0.6.0 exchange event Bundle (envelope rules E1 to E9).

parse_event proves the graph, identity, reference and lifecycle rules and returns a fullUrl-indexed graph; adapter
claims (HealthKit profile, source type, subject) are checked on top of it by the adapter projection.
"""

from __future__ import annotations

import base64
import hashlib
import re
import uuid
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypeGuard

GROVE = "https://grovealliance.org/fhir/"
MOBILE_SD = GROVE + "mobile/StructureDefinition/"
ACTIVE_BUNDLE = MOBILE_SD + "grove-mobile-exchange-bundle"
RETRACTION_BUNDLE = MOBILE_SD + "grove-mobile-retraction-bundle"
RETRACTION_PROVENANCE = MOBILE_SD + "grove-mobile-retraction-provenance"
ENTRY_KEY_EXT = MOBILE_SD + "grove-exchange-entry-node-key"
TARGET_ROLE_EXT = MOBILE_SD + "grove-retraction-target-role"
TARGET_NATIVE_EXT = MOBILE_SD + "grove-retraction-target-native-identifier"
ROLE_SYSTEM = GROVE + "mobile/CodeSystem/grove-identifier-role"
LIFECYCLE_SYSTEM = GROVE + "mobile/CodeSystem/grove-lifecycle-event"
TARGET_ROLE_SYSTEM = GROVE + "mobile/CodeSystem/grove-retraction-target-role"
ISO_LIFECYCLE = "http://terminology.hl7.org/CodeSystem/iso-21089-lifecycle"
PARTICIPANT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type"
RESERVED_SYSTEMS = frozenset({ROLE_SYSTEM, LIFECYCLE_SYSTEM, TARGET_ROLE_SYSTEM})

FULL_URL_NAMESPACE = uuid.UUID("43df4575-bff7-5a57-9a80-2472cd2b0623")
ENTRY_NODE_DOMAIN = "org.grovealliance.fhir.entry-node.v0"

OUTPUT_TYPES = frozenset(
    {
        "Observation",
        "DocumentReference",
        "Specimen",
        "VisionPrescription",
        "MedicationAdministration",
        "MedicationStatement",
    }
)
SUPPORTING_TYPES = frozenset(
    {"Patient", "Device", "ResearchStudy", "ResearchSubject", "PlanDefinition", "QuestionnaireResponse"}
)
ACTIVE_TYPES = OUTPUT_TYPES | SUPPORTING_TYPES | {"Provenance"}
RETRACTION_TYPES = frozenset({"Provenance", "Device"})

OPAQUE_ROLES = frozenset(
    {
        "source-record",
        "source-output",
        "writer-record",
        "source-artifact",
        "source-context",
        "recording-device",
        "device-snapshot",
    }
)
KEY_PRIORITY = (
    "source-output",
    "source-artifact",
    "source-record",
    "writer-record",
    "device-snapshot",
    "recording-device",
)
NODE_ROLES = {
    "Patient": "patient",
    "QuestionnaireResponse": "questionnaire-response",
    "ResearchStudy": "research-study",
    "ResearchSubject": "research-subject",
    "PlanDefinition": "plan-definition",
}

CONVERSION_PROVENANCE_PROFILES = frozenset(
    {
        MOBILE_SD + "grove-mobile-conversion-provenance",
        GROVE + "healthkit/StructureDefinition/healthkit-conversion-provenance",
        GROVE + "health-connect/StructureDefinition/health-connect-conversion-provenance",
        GROVE + "providers/StructureDefinition/providers-conversion-provenance",
        GROVE + "sensorkit/StructureDefinition/sensorkit-conversion-provenance",
    }
)
ADAPTER_ONLY_PROFILES = {
    "Specimen": GROVE + "health-connect/StructureDefinition/health-connect-specimen",
    "VisionPrescription": GROVE + "healthkit/StructureDefinition/healthkit-vision-prescription",
    "MedicationAdministration": GROVE + "healthkit/StructureDefinition/healthkit-medication-dose-event",
    "MedicationStatement": GROVE + "healthkit/StructureDefinition/healthkit-user-annotated-medication",
}
DEVICE_PROFILES = frozenset(
    {
        MOBILE_SD + "grove-recording-device",
        MOBILE_SD + "grove-application-device",
        MOBILE_SD + "grove-host-device",
        GROVE + "healthkit/StructureDefinition/healthkit-application-device",
    }
)
QUESTIONNAIRE_RESPONSE_PROFILE = GROVE + "questionnaire/StructureDefinition/grove-questionnaire-response"

_PATIENT = frozenset({"Patient"})
GOVERNED_PATHS: dict[str, dict[str, tuple[frozenset[str], bool]]] = {
    "Observation": {
        "subject": (_PATIENT, False),
        "device": (frozenset({"Device"}), False),
        "specimen": (frozenset({"Specimen"}), False),
        "focus": (frozenset({"Location"}), True),
        "hasMember": (frozenset({"Observation"}), True),
        "derivedFrom": (frozenset({"Observation", "DocumentReference", "QuestionnaireResponse"}), True),
    },
    "DocumentReference": {"subject": (_PATIENT, False)},
    "QuestionnaireResponse": {"subject": (_PATIENT, False)},
    "Specimen": {"subject": (_PATIENT, False)},
    "MedicationAdministration": {"subject": (_PATIENT, False)},
    "MedicationStatement": {"subject": (_PATIENT, False)},
    "VisionPrescription": {"patient": (_PATIENT, False)},
    "ResearchSubject": {"individual": (_PATIENT, False), "study": (frozenset({"ResearchStudy"}), False)},
    "ResearchStudy": {"protocol": (frozenset({"PlanDefinition"}), True)},
    "Device": {"parent": (frozenset({"Device"}), False)},
}
GOVERNED_EXTENSIONS = {
    "http://hl7.org/fhir/StructureDefinition/observation-gatewayDevice": frozenset({"Device"}),
    "http://hl7.org/fhir/StructureDefinition/workflow-researchStudy": frozenset({"ResearchStudy"}),
}
TARGET_ROLES = {
    "primary-output": (
        "source-output",
        frozenset({"Observation", "VisionPrescription", "MedicationAdministration", "MedicationStatement"}),
    ),
    "child-output": ("source-output", frozenset({"Observation"})),
    "source-artifact": ("source-output", frozenset({"DocumentReference"})),
    "specimen": ("source-output", frozenset({"Specimen"})),
    "device-snapshot": ("device-snapshot", frozenset({"Device"})),
}

V0_IDENTITY = re.compile(r"v0:(?P<key_id>[A-Za-z0-9._-]+):(?P<epoch>[1-9][0-9]*):[A-Za-z0-9_-]{43}")
EVENT_VALUE = re.compile(r"e0:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]*")
ENTRY_NODE = re.compile(r"n0:(?P<role>[a-z][a-z0-9-]*):(?P<ordinal>0|[1-9][0-9]*):[A-Za-z0-9_-]{43}")
ABSOLUTE_URI = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+")

REASONS = frozenset(
    {
        "grove_not_bundle",
        "grove_bundle_profile",
        "grove_bundle_shape",
        "grove_event_identity",
        "grove_empty_bundle",
        "grove_entry_shape",
        "grove_entry_resource_type",
        "grove_retraction_clinical_copy",
        "grove_contained",
        "grove_identifier_role",
        "bad_grove_identity",
        "foreign_identity",
        "duplicate_grove_identity",
        "missing_grove_identity",
        "grove_entry_key",
        "grove_full_url",
        "grove_profile",
        "grove_unresolved_reference",
        "grove_reference_type",
        "grove_reference_target_type",
        "grove_reference_shape",
        "grove_disconnected",
        "grove_lifecycle",
        "grove_source_entity",
        "grove_provenance_agent",
        "grove_provenance_recorded",
        "grove_provenance_occurred",
        "grove_no_output",
        "grove_source_record_mismatch",
        "grove_provenance_targets",
        "grove_retraction_literal_target",
        "grove_retraction_no_target",
        "grove_retraction_target_role",
        "grove_retraction_role_type",
        "grove_retraction_native_identifier",
        "grove_retraction_duplicate_target",
    }
)


class GroveError(ValueError):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(f"{reason}: {message}")
        self.reason = reason
        self.message = message


@dataclass(frozen=True)
class EventConfig:
    deployment_root: str
    accepted_namespaces: tuple[tuple[str, int], ...]
    participant_system: str


@dataclass(frozen=True)
class RetractionTarget:
    role: str
    resource_type: str
    identifier_role: str
    system: str
    value: str
    native_system: str | None
    native_value: str | None


@dataclass
class EventGraph:
    kind: Literal["active", "retraction"]
    event_system: str
    event_value: str
    timestamp: str
    entries: dict[str, dict]
    provenance: dict
    outputs: list[dict]
    targets: list[RetractionTarget]
    source_record: tuple[str, str]

    def resolve(self, ref: dict | None, allowed_types: set[str]) -> dict | None:
        """The entry a literal reference names, or None for an identifier-only logical reference."""
        if ref is None:
            return None
        if not isinstance(ref, dict):
            raise GroveError("grove_reference_shape", "a reference is not an object")
        if "reference" not in ref:
            _check_logical(ref, allowed_types)
            return None
        if "identifier" in ref:
            raise GroveError("grove_reference_shape", "a reference mixes a literal and a logical identifier")
        target = _resolve_literal(ref, self.entries)
        if target["resourceType"] not in allowed_types:
            raise GroveError(
                "grove_reference_target_type", f"{target['resourceType']} is not one of {sorted(allowed_types)}"
            )
        return target


def frame(fields: Sequence[str]) -> bytes:
    """Each field as a 4-byte big-endian byte length followed by its UTF-8 bytes."""
    out = bytearray()
    for field in fields:
        data = field.encode("utf-8")
        out += len(data).to_bytes(4, "big") + data
    return bytes(out)


def entry_full_url(system: str, value: str) -> str:
    # uuid.uuid5 takes a str and would re-encode the length prefixes, so the SHA-1 is taken by hand.
    digest = hashlib.sha1(FULL_URL_NAMESPACE.bytes + frame([system, value])).digest()[:16]
    return f"urn:uuid:{uuid.UUID(bytes=digest, version=5)}"


def entry_node_value(event_system: str, event_value: str, role: str, ordinal: int) -> str:
    digest = hashlib.sha256(frame([ENTRY_NODE_DOMAIN, event_system, event_value, role, str(ordinal)])).digest()
    return f"n0:{role}:{ordinal}:{base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')}"


def parse_event(bundle: dict, cfg: EventConfig) -> EventGraph:
    if not isinstance(bundle, dict) or bundle.get("resourceType") != "Bundle":
        raise GroveError("grove_not_bundle", "an element of a Grove object is not a FHIR Bundle")
    profiles = set(_profiles(bundle))
    if (ACTIVE_BUNDLE in profiles) == (RETRACTION_BUNDLE in profiles):
        raise GroveError("grove_bundle_profile", "the Bundle must claim exactly one of the exchange profiles")
    kind: Literal["active", "retraction"] = "active" if ACTIVE_BUNDLE in profiles else "retraction"
    if bundle.get("type") != "collection" or not _text(bundle.get("timestamp")):
        raise GroveError("grove_bundle_shape", "an exchange Bundle is a collection with a timestamp")
    event_system, event_value = _event_identity(bundle.get("identifier"), cfg)
    _check_system_roles(bundle)
    entries = bundle.get("entry")
    if not isinstance(entries, list) or not entries:
        raise GroveError("grove_empty_bundle", "an exchange Bundle needs at least one entry")

    resources: dict[str, dict] = {}
    typed: dict[str, dict[str, tuple[str, str]]] = {}
    ordinals: dict[str, int] = {}
    for index, entry in enumerate(entries):
        where = f"entry[{index}]"
        resource = entry.get("resource") if isinstance(entry, dict) else None
        if not isinstance(resource, dict) or not isinstance(resource.get("resourceType"), str):
            raise GroveError("grove_entry_shape", f"{where} has no resource")
        if any(key in entry for key in ("request", "response", "search")):
            raise GroveError("grove_entry_shape", f"{where} carries request, response or search")
        resource_type = resource["resourceType"]
        if kind == "retraction" and resource_type not in RETRACTION_TYPES:
            raise GroveError("grove_retraction_clinical_copy", f"{where} is a {resource_type} in a retraction")
        if resource_type not in ACTIVE_TYPES:
            raise GroveError("grove_entry_resource_type", f"{where} is a {resource_type}")
        if "contained" in resource:
            raise GroveError("grove_contained", f"{where} has contained resources")
        identities = _typed_identifiers(resource, cfg, where)
        if (
            kind == "active"
            and resource_type in OUTPUT_TYPES
            and not {"source-record", "source-output"} <= identities.keys()
        ):
            raise GroveError(
                "missing_grove_identity", f"{where} output lacks a source-record or source-output identity"
            )
        key = _entry_key(entry, resource, identities, kind, (event_system, event_value), ordinals, cfg, where)
        full_url = entry_full_url(*key)
        if entry.get("fullUrl") != full_url:
            raise GroveError("grove_full_url", f"{where} fullUrl is not {full_url}")
        if full_url in resources:
            raise GroveError("grove_entry_key", f"{where} repeats the entry key {key[1]}")
        _check_profile(resource, kind, where)
        resources[full_url] = resource
        typed[full_url] = identities

    if kind == "retraction":
        for resource in resources.values():
            if any(isinstance(t, dict) and "reference" in t for t in _list(resource.get("target"))):
                raise GroveError("grove_retraction_literal_target", "a retraction target has a literal reference")
    _check_references(resources)
    if kind == "active":
        _check_connected(resources)

    provenances = [(url, r) for url, r in resources.items() if r["resourceType"] == "Provenance"]
    if len(provenances) != 1:
        raise GroveError("grove_lifecycle", f"an event has exactly one lifecycle Provenance, not {len(provenances)}")
    provenance = provenances[0][1]
    codings = _codings(provenance.get("activity"))
    iso = [c.get("code") for c in codings if c.get("system") == ISO_LIFECYCLE]
    grove = [c.get("code") for c in codings if c.get("system") == LIFECYCLE_SYSTEM]
    if (iso, grove) != ((["transform"], []) if kind == "active" else ([], ["source-record-retracted"])):
        raise GroveError("grove_lifecycle", f"activity {iso + grove} does not make a {kind} event")
    source_record = _source_entity(provenance, cfg)
    _check_assembler(provenance, resources)
    if not _text(provenance.get("recorded")):
        raise GroveError("grove_provenance_recorded", "the Provenance has no recorded instant")
    if not (_text(provenance.get("occurredDateTime")) or isinstance(provenance.get("occurredPeriod"), dict)):
        raise GroveError("grove_provenance_occurred", "the Provenance has no occurred[x]")

    graph = EventGraph(
        kind=kind,
        event_system=event_system,
        event_value=event_value,
        timestamp=bundle["timestamp"],
        entries=resources,
        provenance=provenance,
        outputs=[],
        targets=[],
        source_record=source_record,
    )
    if kind == "retraction":
        graph.targets = _retraction_targets(provenance, cfg)
        return graph
    outputs = [url for url, r in resources.items() if r["resourceType"] in OUTPUT_TYPES]
    if not outputs:
        raise GroveError("grove_no_output", "an active event has no output")
    if any(typed[url]["source-record"] != source_record for url in outputs):
        raise GroveError("grove_source_record_mismatch", "an output's source record differs from the Provenance entity")
    targets = _list(provenance.get("target"))
    literals = [t.get("reference") for t in targets if isinstance(t, dict) and "identifier" not in t]
    if (
        len(literals) != len(targets)
        or not all(isinstance(r, str) for r in literals)
        or len(set(literals)) != len(literals)
        or set(literals) != set(outputs)
    ):
        raise GroveError("grove_provenance_targets", "the Provenance must target every output exactly once")
    graph.outputs = [resources[url] for url in outputs]
    return graph


def _event_identity(identifier: Any, cfg: EventConfig) -> tuple[str, str]:
    if not isinstance(identifier, dict):
        raise GroveError("grove_event_identity", "the Bundle has no event identifier")
    system, value = identifier.get("system"), identifier.get("value")
    if len(_codings(identifier.get("type"))) != 1 or _roles(identifier) != ["event"]:
        raise GroveError("grove_event_identity", "the event identifier must carry exactly the event role coding")
    if not isinstance(value, str) or not EVENT_VALUE.fullmatch(value) or not _text(system):
        raise GroveError("grove_event_identity", f"{value!r} is not a canonical e0 event identity")
    if system != _naming_system(cfg, "grove-event-v0"):
        raise GroveError("foreign_identity", f"event system {system} is not this deployment's")
    return system, value


def _check_system_roles(bundle: dict) -> None:
    roles: dict[str, set[str]] = {}
    for node in _walk(bundle):
        system = node.get("system")
        if isinstance(system, str):
            for role in _roles(node):
                if role is not None:
                    roles.setdefault(system, set()).add(role)
    for system, found in roles.items():
        if len(found) > 1:
            raise GroveError("grove_identifier_role", f"{system} is used for roles {sorted(found)}")


def _typed_identifiers(resource: dict, cfg: EventConfig, where: str) -> dict[str, tuple[str, str]]:
    raw = resource.get("identifier")
    found: dict[str, tuple[str, str]] = {}
    for identifier in [raw] if isinstance(raw, dict) else _list(raw):
        if not isinstance(identifier, dict) or not (roles := _roles(identifier)):
            continue
        if len(roles) != 1 or roles[0] not in OPAQUE_ROLES:
            raise GroveError("grove_identifier_role", f"{where} identifier roles {roles} are not one opaque role")
        if roles[0] in found:
            raise GroveError("duplicate_grove_identity", f"{where} repeats the {roles[0]} identifier")
        found[roles[0]] = _opaque(identifier, roles[0], cfg, where)
    return found


def _opaque(identifier: dict, role: str, cfg: EventConfig, where: str) -> tuple[str, str]:
    system, value = identifier.get("system"), identifier.get("value")
    match = V0_IDENTITY.fullmatch(value) if isinstance(value, str) else None
    if match is None or not isinstance(system, str):
        raise GroveError("bad_grove_identity", f"{where} {role} identifier is not a v0 opaque identity")
    key_id, epoch = match["key_id"], match["epoch"]
    expected = _naming_system(cfg, f"grove-{role}-v0/{key_id}/{epoch}")
    # int() on an unbounded digit run raises past CPython's int-string limit.
    if (key_id, epoch) not in {(k, str(e)) for k, e in cfg.accepted_namespaces} or system != expected:
        raise GroveError("foreign_identity", f"{where} {role} identifier {system} is not under an accepted namespace")
    return system, match.string


def _entry_key(
    entry: dict,
    resource: dict,
    identities: dict[str, tuple[str, str]],
    kind: str,
    event: tuple[str, str],
    ordinals: dict[str, int],
    cfg: EventConfig,
    where: str,
) -> tuple[str, str]:
    keys = [e.get("valueIdentifier") for e in _list(entry.get("extension")) if _ext_url(e) == ENTRY_KEY_EXT]
    if len(keys) != 1 or not isinstance(keys[0], dict):
        raise GroveError("grove_entry_key", f"{where} must carry exactly one entry node key")
    if resource["resourceType"] == "Provenance" and "identifier" in resource:
        raise GroveError("grove_entry_key", f"{where} Provenance has no identifier and is keyed by its entry node")
    system, value, roles = keys[0].get("system"), keys[0].get("value"), _roles(keys[0])
    if not (isinstance(system, str) and ABSOLUTE_URI.fullmatch(system) and _text(value) and len(roles) == 1):
        raise GroveError("grove_entry_key", f"{where} entry key is not a complete role-typed identifier")
    selected = next(((role, identities[role]) for role in KEY_PRIORITY if role in identities), None)
    if selected is not None:
        if (roles[0], (system, value)) != selected:
            raise GroveError("grove_entry_key", f"{where} key is not the resource's {selected[0]} identifier")
        return system, value
    match = ENTRY_NODE.fullmatch(value)
    if roles[0] != "entry-node" or match is None or system != _naming_system(cfg, "grove-entry-node-v0"):
        raise GroveError("grove_entry_key", f"{where} needs a canonical entry-node key")
    resource_type = resource["resourceType"]
    expected_role = (
        ("conversion-provenance" if kind == "active" else "retraction-provenance")
        if resource_type == "Provenance"
        else NODE_ROLES.get(resource_type)
    )
    if expected_role is None or match["role"] != expected_role:
        raise GroveError("grove_entry_key", f"{where} node role {match['role']} does not fit a {resource_type}")
    ordinal = ordinals.get(expected_role, 0)
    ordinals[expected_role] = ordinal + 1
    if value != entry_node_value(*event, expected_role, ordinal):
        raise GroveError("grove_entry_key", f"{where} key is not n0:{expected_role}:{ordinal} of this event")
    return system, value


def _check_profile(resource: dict, kind: str, where: str) -> None:
    resource_type, profiles = resource["resourceType"], _profiles(resource)
    if resource_type == "Provenance":
        admitted = {RETRACTION_PROVENANCE} if kind == "retraction" else CONVERSION_PROVENANCE_PROFILES
        valid = len(profiles) == 1 and profiles[0] in admitted
    elif resource_type in ADAPTER_ONLY_PROFILES:
        valid = profiles == [ADAPTER_ONLY_PROFILES[resource_type]]
    elif resource_type in OUTPUT_TYPES:
        valid = bool(profiles) and all(profiles) and len(set(profiles)) == len(profiles)
    elif resource_type == "Device":
        valid = len(profiles) == 1 and profiles[0] in DEVICE_PROFILES
    elif resource_type == "QuestionnaireResponse":
        valid = profiles == [QUESTIONNAIRE_RESPONSE_PROFILE]
    else:
        valid = True
    if not valid:
        raise GroveError("grove_profile", f"{where} {resource_type} claims {profiles}")


def _check_references(resources: dict[str, dict]) -> None:
    for resource in resources.values():
        for ref in _literal_refs(resource):
            _resolve_literal(ref, resources)
        resource_type = resource["resourceType"]
        lifecycle = _lifecycle_references(resource)
        for node in _walk(resource):
            if node is resource or "identifier" not in node or id(node) in lifecycle:
                continue
            if "reference" in node:
                raise GroveError("grove_reference_shape", f"a {resource_type} reference mixes literal and identifier")
            if not isinstance(node["identifier"], list):
                _check_identifier_only(node)
        for path, (allowed, repeating) in GOVERNED_PATHS.get(resource_type, {}).items():
            if path not in resource:
                continue
            value = resource[path]
            refs = value if repeating else [value]
            if not isinstance(refs, list) or not all(isinstance(r, dict) for r in refs):
                raise GroveError("grove_reference_shape", f"{resource_type}.{path} is not a Reference")
            for ref in refs:
                _check_governed(ref, allowed, resources, f"{resource_type}.{path}")
        for ext in _extensions(resource):
            if (targets := GOVERNED_EXTENSIONS.get(_ext_url(ext))) is None:
                continue
            if [k for k in ext if k.startswith("value")] != ["valueReference"] or not isinstance(
                ext["valueReference"], dict
            ):
                raise GroveError("grove_reference_shape", f"{_ext_url(ext)} must carry one valueReference")
            _check_governed(ext["valueReference"], targets, resources, _ext_url(ext))


def _lifecycle_references(resource: dict) -> set[int]:
    """Provenance entity and target references, which the lifecycle checks validate under their own reasons."""
    if resource["resourceType"] != "Provenance":
        return set()
    whats = [e.get("what") for e in _list(resource.get("entity")) if isinstance(e, dict)]
    return {id(node) for node in [*whats, *_list(resource.get("target"))] if isinstance(node, dict)}


def _check_governed(ref: dict, allowed: frozenset[str], resources: dict[str, dict], where: str) -> None:
    if "reference" not in ref:
        _check_logical(ref, allowed)
        return
    if "identifier" in ref or not isinstance(ref["reference"], str):
        raise GroveError("grove_reference_shape", f"{where} mixes a literal and a logical reference")
    target_type = resources[ref["reference"]]["resourceType"]
    if target_type not in allowed:
        raise GroveError("grove_reference_target_type", f"{where} references a {target_type}")


def _check_logical(ref: dict, allowed: set[str] | frozenset[str]) -> None:
    ref_type = ref.get("type")
    if not isinstance(ref_type, str) or ref_type not in allowed:
        raise GroveError("grove_reference_shape", f"a logical reference needs a type in {sorted(allowed)}")
    _check_identifier_only(ref)


def _check_identifier_only(ref: dict) -> None:
    """Shape every identifier-only reference shares; adapters may omit the type off the governed paths."""
    identifier = ref.get("identifier")
    if not isinstance(identifier, dict):
        raise GroveError("grove_reference_shape", "a logical reference needs one Identifier")
    system = identifier.get("system")
    if not (isinstance(system, str) and ABSOLUTE_URI.fullmatch(system) and _text(identifier.get("value"))):
        raise GroveError("grove_reference_shape", "a logical reference needs an absolute system and a value")
    if ref.get("type") == "Patient" and (system in RESERVED_SYSTEMS or _roles(identifier)):
        raise GroveError("grove_reference_shape", "a logical Patient pseudonym uses a Grove role or reserved system")


def _resolve_literal(ref: dict, resources: dict[str, dict]) -> dict:
    literal = ref.get("reference")
    target = resources.get(literal) if isinstance(literal, str) else None
    if target is None:
        raise GroveError("grove_unresolved_reference", f"{literal!r} is not an entry of this event")
    if "type" in ref and ref["type"] != target["resourceType"]:
        raise GroveError("grove_reference_type", f"{literal} is a {target['resourceType']}, not {ref['type']!r}")
    return target


def _check_connected(resources: dict[str, dict]) -> None:
    adjacent: dict[str, set[str]] = {url: set() for url in resources}
    for url, resource in resources.items():
        for ref in _literal_refs(resource):
            adjacent[url].add(ref["reference"])
            adjacent[ref["reference"]].add(url)
    reached = {url for url, r in resources.items() if r["resourceType"] not in SUPPORTING_TYPES}
    pending = list(reached)
    while pending:
        for neighbour in adjacent[pending.pop()] - reached:
            reached.add(neighbour)
            pending.append(neighbour)
    if loose := sorted(set(resources) - reached):
        raise GroveError("grove_disconnected", f"supporting entries {loose} reach no output or Provenance")


def _source_entity(provenance: dict, cfg: EventConfig) -> tuple[str, str]:
    entities = provenance.get("entity")
    if not isinstance(entities, list) or len(entities) != 1:
        raise GroveError("grove_source_entity", "the Provenance must name exactly one source entity")
    entity = entities[0]
    what = entity.get("what") if isinstance(entity, dict) else None
    if not isinstance(what, dict) or entity.get("role") != "source" or "reference" in what:
        raise GroveError("grove_source_entity", "the source entity must be a logical identifier with role source")
    identifier = what.get("identifier")
    if not isinstance(identifier, dict) or _roles(identifier) != ["source-record"]:
        raise GroveError("grove_source_entity", "the source entity must carry a source-record identifier")
    return _opaque(identifier, "source-record", cfg, "Provenance.entity")


def _check_assembler(provenance: dict, resources: dict[str, dict]) -> None:
    assemblers = [
        a
        for a in _list(provenance.get("agent"))
        if isinstance(a, dict)
        and any(c.get("system") == PARTICIPANT_TYPE and c.get("code") == "assembler" for c in _codings(a.get("type")))
    ]
    who = assemblers[0].get("who") if len(assemblers) == 1 else None
    if not isinstance(who, dict):
        raise GroveError("grove_provenance_agent", "the Provenance needs exactly one assembler agent")
    if "reference" in who:
        literal = who["reference"]
        valid = "identifier" not in who and isinstance(literal, str) and resources[literal]["resourceType"] == "Device"
    else:
        identifier = who.get("identifier")
        valid = (
            who.get("type") == "Device"
            and isinstance(identifier, dict)
            and isinstance(identifier.get("system"), str)
            and bool(ABSOLUTE_URI.fullmatch(identifier["system"]))
            and _text(identifier.get("value"))
        )
    if not valid:
        raise GroveError("grove_provenance_agent", "the assembler must be a Device")


def _retraction_targets(provenance: dict, cfg: EventConfig) -> list[RetractionTarget]:
    targets = provenance.get("target")
    if not isinstance(targets, list) or not targets:
        raise GroveError("grove_retraction_no_target", "a retraction names no target")
    found: list[RetractionTarget] = []
    seen: set[tuple[str, str]] = set()
    for index, target in enumerate(targets):
        where = f"Provenance.target[{index}]"
        if not isinstance(target, dict):
            raise GroveError("grove_retraction_role_type", f"{where} is not a Reference")
        resource_type, identifier = target.get("type"), target.get("identifier")
        if not isinstance(resource_type, str):
            raise GroveError("grove_retraction_role_type", f"{where} states no resource type")
        if not isinstance(identifier, dict):
            raise GroveError("bad_grove_identity", f"{where} has no identifier")
        roles = _roles(identifier)
        if len(roles) != 1 or roles[0] not in OPAQUE_ROLES:
            raise GroveError("grove_identifier_role", f"{where} identifier roles {roles} are not one opaque role")
        role_exts = [e for e in _list(target.get("extension")) if _ext_url(e) == TARGET_ROLE_EXT]
        role = role_exts[0].get("valueCode") if len(role_exts) == 1 else None
        if not isinstance(role, str) or role not in TARGET_ROLES:
            raise GroveError("grove_retraction_target_role", f"{where} needs exactly one admitted target role")
        identifier_role, resource_types = TARGET_ROLES[role]
        if roles[0] != identifier_role or resource_type not in resource_types:
            raise GroveError("grove_retraction_role_type", f"{where} {role} cannot be a {resource_type}/{roles[0]}")
        system, value = _opaque(identifier, identifier_role, cfg, where)
        native_system, native_value = _native_identifier(target, where)
        if (system, value) in seen:
            raise GroveError("grove_retraction_duplicate_target", f"{where} repeats {value}")
        seen.add((system, value))
        found.append(RetractionTarget(role, resource_type, identifier_role, system, value, native_system, native_value))
    return found


def _native_identifier(target: dict, where: str) -> tuple[str | None, str | None]:
    exts = [e for e in _list(target.get("extension")) if _ext_url(e) == TARGET_NATIVE_EXT]
    if not exts:
        return None, None
    identifier = exts[0].get("valueIdentifier")
    if len(exts) != 1 or set(exts[0]) != {"url", "valueIdentifier"} or not isinstance(identifier, dict):
        raise GroveError("grove_retraction_native_identifier", f"{where} needs at most one native identifier")
    system, value = identifier.get("system"), identifier.get("value")
    if not (isinstance(system, str) and ABSOLUTE_URI.fullmatch(system) and _text(value)) or _roles(identifier):
        raise GroveError("grove_retraction_native_identifier", f"{where} native identifier is not a plain system/value")
    return system, value


def _naming_system(cfg: EventConfig, suffix: str) -> str:
    return f"{cfg.deployment_root.rstrip('/')}/NamingSystem/{suffix}"


def _text(value: Any) -> TypeGuard[str]:
    return isinstance(value, str) and bool(value)


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _url(value: Any) -> str:
    return value.split("|", 1)[0] if isinstance(value, str) else ""


def _ext_url(ext: Any) -> str:
    return _url(ext.get("url")) if isinstance(ext, dict) else ""


def _profiles(resource: dict) -> list[str]:
    meta = resource.get("meta")
    return [_url(p) for p in _list(meta.get("profile"))] if isinstance(meta, dict) else []


def _codings(concept: Any) -> list[dict]:
    return [c for c in _list(concept.get("coding")) if isinstance(c, dict)] if isinstance(concept, dict) else []


def _roles(identifier: dict) -> list[str | None]:
    """Codes of the grove-identifier-role codings; a non-string code counts as None."""
    codes = [c.get("code") for c in _codings(identifier.get("type")) if c.get("system") == ROLE_SYSTEM]
    return [code if isinstance(code, str) else None for code in codes]


def _walk(node: Any) -> Iterator[dict]:
    """Every object below node in document order, iteratively so nesting depth cannot exhaust the stack."""
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            yield current
            stack.extend(reversed(current.values()))
        elif isinstance(current, list):
            stack.extend(reversed(current))


def _literal_refs(resource: dict) -> Iterator[dict]:
    return (node for node in _walk(resource) if node is not resource and isinstance(node.get("reference"), str))


def _extensions(resource: dict) -> Iterator[dict]:
    for node in _walk(resource):
        yield from (e for e in _list(node.get("extension")) if isinstance(e, dict))
