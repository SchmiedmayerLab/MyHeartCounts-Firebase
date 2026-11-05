# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""HealthKit projection of a validated Grove exchange event.

parse_event (grove/event.py) proves the event is structurally sound; this module checks the HealthKit adapter
claims for one unit (conversion profile, source type, clinical code, subject) and reads the analytics descriptors
from the exact graph paths the HealthKit adapter defines. Every failure is a GroveError with a stable reason, which
the worker treats as fatal input. Names, titles, free text and the clear HealthKit UUID never leave this module
except through the explicitly exported columns.
"""

from __future__ import annotations

import dataclasses
import re
from typing import Any

from mhc_export.config import GroveSettings
from mhc_export.grove.event import EventGraph, GroveError, RetractionTarget
from mhc_export.grove.view import Device, ObservationView, SourceRevision, _grove_identifiers, _parse_grove
from mhc_export.identity.grove_ids import IdentityError, canonical_uuid
from mhc_export.transform.specs import TypeSpec

HK_CONVERSION_PROVENANCE = (
    "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-conversion-provenance"
)
HK_SOURCE_TYPE = "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-source-type"
RECORDING_DEVICE = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-recording-device"
APPLICATION_DEVICES = {
    "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-application-device",
    "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-application-device",
}
HK_APPLICATION_DEVICE = "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-application-device"
PARTICIPANT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type"
MDC = "urn:iso:std:iso:11073:10101"
APP_VERSION_TYPE = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-application-version-type"
HK_IDENTIFIER_TYPE = "https://grovealliance.org/fhir/healthkit/CodeSystem/healthkit-identifier-type"
APPLE_BUNDLE_ID = "https://grovealliance.org/fhir/healthkit/NamingSystem/apple-bundle-id"
RESEARCH_STUDY_EXT = "http://hl7.org/fhir/StructureDefinition/workflow-researchStudy"
RECORDING_METHOD_EXT = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-recording-method"
RECORDING_METHOD_SYSTEM = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-recording-method"
RECORDING_METHODS = {"manual-entry", "actively-recorded", "automatically-recorded"}
GROVE_ROLE_SYSTEM = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role"
INTEGER = re.compile(r"0|[1-9][0-9]*")
OBSERVATION_TARGET_ROLES = {"primary-output", "child-output"}
REASONS = frozenset(
    {
        "grove_not_healthkit",
        "grove_provenance_recorded",
        "grove_provenance_agent",
        "grove_unexpected_output",
        "grove_missing_source_type",
        "grove_source_type_mismatch",
        "grove_code_mismatch",
        "grove_output_profile",
        "grove_source_record_mismatch",
        "grove_subject_mismatch",
        "grove_study_conflict",
        "grove_recording_method",
        "grove_retraction_unmapped",
        "missing_native_identifier",
        "bad_native_identifier",
    }
)


def _url(value: Any) -> str:
    return str(value or "").split("|", 1)[0]


def _profiles(resource: dict) -> list[str]:
    return [_url(p) for p in ((resource.get("meta") or {}).get("profile") or [])]


def _has_coding(concept: dict | None, system: str, code: str) -> bool:
    return any(
        isinstance(c, dict) and c.get("system") == system and c.get("code") == code
        for c in ((concept or {}).get("coding") or [])
    )


def _version(device: dict, system: str, code: str) -> str | None:
    for version in device.get("version") or []:
        if isinstance(version, dict) and _has_coding(version.get("type"), system, code):
            value = version.get("value")
            return str(value) if value is not None else None
    return None


def _extensions(resource: dict, url: str) -> list[dict]:
    return [e for e in (resource.get("extension") or []) if isinstance(e, dict) and _url(e.get("url")) == url]


def _agent(provenance_or_entity: dict, role: str) -> list[dict]:
    return [
        a
        for a in (provenance_or_entity.get("agent") or [])
        if isinstance(a, dict) and _has_coding(a.get("type"), PARTICIPANT_TYPE, role)
    ]


def _recording_device(graph: EventGraph, observation: dict, warnings: list[str]) -> Device | None:
    device = graph.resolve(observation.get("device"), {"Device"})
    if device is None:
        return None
    if _profiles(device) != [RECORDING_DEVICE]:
        warnings.append("grove_device_profile")
        return None
    return Device(
        manufacturer=device.get("manufacturer"),
        model=device.get("modelNumber"),
        hardware=_version(device, MDC, "531974"),
        software=_version(device, MDC, "531975"),
        firmware=_version(device, MDC, "531976"),
    )


def _converter(graph: EventGraph) -> tuple[str | None, str | None]:
    assemblers = _agent(graph.provenance, "assembler")
    if len(assemblers) != 1:
        raise GroveError("grove_provenance_agent", "a conversion Provenance needs exactly one assembler")
    app = graph.resolve(assemblers[0].get("who"), {"Device"})
    if app is None or not set(_profiles(app)) & APPLICATION_DEVICES:
        return None, None
    return _version(app, MDC, "531975"), _version(app, APP_VERSION_TYPE, "build")


def _source_author(graph: EventGraph) -> SourceRevision | None:
    entities = graph.provenance.get("entity") or []
    if not entities:
        return None
    for author in _agent(entities[0], "author"):
        device = graph.resolve(author.get("who"), {"Device"})
        if device is None or HK_APPLICATION_DEVICE not in _profiles(device):
            continue  # a recording-device author carries no application bundle
        bundle = None
        for ident in device.get("identifier") or []:
            if (
                isinstance(ident, dict)
                and ident.get("system") == APPLE_BUNDLE_ID
                and _has_coding(ident.get("type"), HK_IDENTIFIER_TYPE, "apple-bundle-id")
            ):
                bundle = ident.get("value")
        return SourceRevision(bundle_identifier=bundle, version=_version(device, MDC, "531975"))
    return None


def _study_revision(graph: EventGraph, observation: dict, settings: GroveSettings, warnings: list[str]) -> int | None:
    versions: set[str] = set()
    for ext in _extensions(observation, RESEARCH_STUDY_EXT):
        study = graph.resolve(ext.get("valueReference"), {"ResearchStudy"})
        if study is None:
            continue
        for protocol in study.get("protocol") or []:
            plan = graph.resolve(protocol, {"PlanDefinition"})
            if (
                plan is not None
                and _url(plan.get("url")) == settings.study_protocol
                and plan.get("version") is not None
            ):
                versions.add(str(plan["version"]))
    if len(versions) > 1:
        raise GroveError("grove_study_conflict", f"several revisions of the MHC study: {sorted(versions)}")
    if not versions:
        return None
    version = versions.pop()
    if not INTEGER.fullmatch(version):
        warnings.append("study_revision_not_integer")
        return None
    return int(version)


def _recording_method(observation: dict) -> str | None:
    found = _extensions(observation, RECORDING_METHOD_EXT)
    if not found:
        return None
    coding = found[0].get("valueCoding") or {}
    if len(found) > 1 or coding.get("system") != RECORDING_METHOD_SYSTEM or coding.get("code") not in RECORDING_METHODS:
        raise GroveError("grove_recording_method", "recording method is not a single grove-recording-method coding")
    return str(coding["code"])


def _check_subject(graph: EventGraph, observation: dict, uid: str, settings: GroveSettings) -> None:
    subject = observation.get("subject")
    if not isinstance(subject, dict):
        raise GroveError("grove_subject_mismatch", "the observation has no subject")
    patient = graph.resolve(subject, {"Patient"})
    identifiers = (patient or {}).get("identifier") or [] if patient is not None else [subject.get("identifier") or {}]
    values = [
        i.get("value") for i in identifiers if isinstance(i, dict) and i.get("system") == settings.participant_system
    ]
    if values != [uid]:
        raise GroveError("grove_subject_mismatch", "the observation's participant is not the owner of the object")


def _canonical_native(value: object) -> str:
    try:
        return canonical_uuid(str(value))
    except IdentityError as exc:
        raise GroveError("bad_native_identifier", "a disclosed HealthKit record id is not a UUID") from exc


def _native_uuid(observation: dict, settings: GroveSettings) -> str:
    values = [
        i.get("value")
        for i in observation.get("identifier") or []
        if isinstance(i, dict) and i.get("system") == settings.native_record_system and i.get("value")
    ]
    if len(values) != 1:
        raise GroveError("missing_native_identifier", "the observation must disclose exactly one HealthKit record id")
    return _canonical_native(values[0])


def views_from_event(
    graph: EventGraph, *, uid: str, spec: TypeSpec, settings: GroveSettings, warnings: list[str]
) -> list[ObservationView]:
    """One ObservationView per output of an active event, with every adapter claim checked."""
    if _profiles(graph.provenance) != [HK_CONVERSION_PROVENANCE]:
        raise GroveError("grove_not_healthkit", "the conversion Provenance is not the HealthKit adapter's")
    if not graph.provenance.get("recorded"):
        raise GroveError("grove_provenance_recorded", "the conversion Provenance has no recorded instant")
    app_version, app_build = _converter(graph)
    source = _source_author(graph)
    views: list[ObservationView] = []
    for output in graph.outputs:
        if output.get("resourceType") != "Observation":
            raise GroveError("grove_unexpected_output", f"{output.get('resourceType')} outputs are not exported")
        markers = _extensions(output, HK_SOURCE_TYPE)
        if not markers:
            raise GroveError("grove_missing_source_type", "the observation carries no healthkit-source-type")
        if len(markers) != 1 or markers[0].get("valueCode") != spec.sample_type:
            raise GroveError(
                "grove_source_type_mismatch", f"{markers[0].get('valueCode')} in a {spec.sample_type} object"
            )
        if spec.code and not _has_coding(output.get("code"), *spec.code):
            raise GroveError("grove_code_mismatch", f"the observation is not coded {spec.code[0]}|{spec.code[1]}")
        if not _profiles(output):
            raise GroveError("grove_output_profile", "the observation claims no profile")
        identifiers, duplicates = _grove_identifiers(output)
        if identifiers.get("source-record") != graph.source_record:
            raise GroveError("grove_source_record_mismatch", "the observation's source record differs from the event's")
        _check_subject(graph, output, uid, settings)
        base = _parse_grove(output, "Observation", identifiers, duplicates)
        views.append(
            dataclasses.replace(
                base,
                native_uuid=_native_uuid(output, settings),
                device=_recording_device(graph, output, warnings),
                source=source,
                app_version=app_version,
                app_build=app_build,
                study_revision=_study_revision(graph, output, settings, warnings),
                recording_method=_recording_method(output),
                recorded=str(graph.provenance["recorded"]),
            )
        )
    return views


def retracted_natives(graph: EventGraph, settings: GroveSettings) -> tuple[list[str], int]:
    """HealthKit record ids named by a retraction's Observation targets, and the number of other targets ignored.

    The export addresses samples by its own identity minted from the HealthKit record id, so each Observation target
    must disclose that id in its native-identifier extension; the producer's opaque value is validated by
    parse_event but cannot be mapped to the export identity on its own."""
    natives: list[str] = []
    ignored = 0
    for target in graph.targets:
        if target.role not in OBSERVATION_TARGET_ROLES or target.resource_type != "Observation":
            ignored += 1
            continue
        natives.append(_target_native(target, settings))
    return natives, ignored


def _target_native(target: RetractionTarget, settings: GroveSettings) -> str:
    if target.native_system != settings.native_record_system or not target.native_value:
        raise GroveError("grove_retraction_unmapped", "a retraction target does not disclose its HealthKit record id")
    return _canonical_native(target.native_value)
