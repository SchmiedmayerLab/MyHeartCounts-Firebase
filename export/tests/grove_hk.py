# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""HealthKit exchange events shaped like the ones MHC iOS writes, for tests."""

from __future__ import annotations

import uuid
from typing import Any

from mhc_export.config import (
    DEFAULT_DEPLOYMENT_ROOT,
    DEFAULT_NATIVE_RECORD_SYSTEM,
    DEFAULT_PARTICIPANT_SYSTEM,
    DEFAULT_STUDY_PROTOCOL,
)
from mhc_export.grove.event import ENTRY_KEY_EXT, ROLE_SYSTEM, entry_full_url, entry_node_value
from mhc_export.grove.healthkit import (
    APP_VERSION_TYPE,
    APPLE_BUNDLE_ID,
    HK_APPLICATION_DEVICE,
    HK_CONVERSION_PROVENANCE,
    HK_IDENTIFIER_TYPE,
    HK_SOURCE_TYPE,
    MDC,
    PARTICIPANT_TYPE,
    RECORDING_DEVICE,
    RECORDING_METHOD_EXT,
    RECORDING_METHOD_SYSTEM,
    RESEARCH_STUDY_EXT,
)
from mhc_export.identity.grove_ids import GroveKey, identifier_system, opaque_identity

PRODUCER_KEY = GroveKey(bytes(range(32)), "store", 1)
ROOT = DEFAULT_DEPLOYMENT_ROOT
HR = "HKQuantityTypeIdentifierHeartRate"
STORE_SYSTEM = "https://myheartcounts.stanford.edu/fhir/NamingSystem/healthkit-repository"
MOBILE_SD = "https://grovealliance.org/fhir/mobile/StructureDefinition/"
WRITER_VERSION = MOBILE_SD + "grove-writer-record-version"
EVENT_SERIES = "1f5c58aa-6ec6-4e79-a682-829a9debd3f5"


def _role(code: str) -> dict:
    return {"coding": [{"system": ROLE_SYSTEM, "code": code}]}


def _opaque(kind: str, components: list[str], key: GroveKey) -> dict:
    return {
        "type": _role(kind),
        "system": identifier_system(ROOT, kind, key),
        "value": opaque_identity(key, kind, components),
    }


def _scope(uid: str) -> list[str]:
    return [STORE_SYSTEM, f"healthkit:STORE-1:{uid}"]


def source_record(uid: str, sample_type: str, native: str, key: GroveKey = PRODUCER_KEY) -> dict:
    return _opaque("source-record", ["healthkit", sample_type, *_scope(uid), native.lower()], key)


def source_output(uid: str, sample_type: str, native: str, measurement: str, key: GroveKey = PRODUCER_KEY) -> dict:
    return _opaque(
        "source-output", ["healthkit", sample_type, *_scope(uid), native.lower(), measurement, "single"], key
    )


def _snapshot(name: str, key: GroveKey) -> dict:
    return _opaque("device-snapshot", ["healthkit", "snapshot", STORE_SYSTEM, name], key)


class _Event:
    def __init__(self, seq: int) -> None:
        self.system = f"{ROOT}/NamingSystem/grove-event-v0"
        self.value = f"e0:{EVENT_SERIES}:{seq}"
        self.entries: list[dict] = []

    def add(self, resource: dict, key: dict) -> str:
        url = entry_full_url(key["system"], key["value"])
        self.entries.append(
            {"extension": [{"url": ENTRY_KEY_EXT, "valueIdentifier": key}], "fullUrl": url, "resource": resource}
        )
        return url

    def node(self, role: str, ordinal: int = 0) -> dict:
        return {
            "type": _role("entry-node"),
            "system": f"{ROOT}/NamingSystem/grove-entry-node-v0",
            "value": entry_node_value(self.system, self.value, role, ordinal),
        }

    def bundle(self, profile: str, timestamp: str) -> dict:
        return {
            "resourceType": "Bundle",
            "meta": {"profile": [MOBILE_SD + profile]},
            "type": "collection",
            "identifier": {"type": _role("event"), "system": self.system, "value": self.value},
            "timestamp": timestamp,
            "entry": self.entries,
        }


def _app_device(key: GroveKey) -> tuple[dict, dict]:
    ident = _snapshot("mhc-app", key)
    return (
        {
            "resourceType": "Device",
            "meta": {"profile": [MOBILE_SD + "grove-application-device"]},
            "identifier": [ident],
            "deviceName": [{"type": "user-friendly-name", "name": "MyHeart Counts"}],
            "version": [
                {"type": {"coding": [{"system": MDC, "code": "531975"}]}, "value": "3.1.0"},
                {"type": {"coding": [{"system": APP_VERSION_TYPE, "code": "build"}]}, "value": "412"},
            ],
        },
        ident,
    )


def hk_event(
    uid: str,
    native: str,
    *,
    sample_type: str = HR,
    measurement: str = "heart-rate",
    code: tuple[str, str] = ("http://loinc.org", "8867-4"),
    value: dict | None = None,
    effective: dict | None = None,
    recorded: str = "2026-08-20T17:30:02Z",
    writer: tuple[str, str] | None = None,
    study_version: str | None = "44",
    recording_method: str | None = "automatically-recorded",
    author_bundle: str | None = "com.apple.health.81C3A8D5",
    seq: int = 1,
    key: GroveKey = PRODUCER_KEY,
    status: str = "final",
) -> dict:
    """One active event with one Observation, a recording device, the MHC app as assembler, the source app as
    author and the study attribution; writer is (sync identifier, version)."""
    event = _Event(seq)
    patient = event.add(
        {"resourceType": "Patient", "identifier": [{"system": DEFAULT_PARTICIPANT_SYSTEM, "value": uid}]},
        event.node("patient"),
    )
    watch_id = _snapshot("watch", key)
    watch = event.add(
        {
            "resourceType": "Device",
            "meta": {"profile": [RECORDING_DEVICE]},
            "identifier": [watch_id],
            "manufacturer": "Apple Inc.",
            "modelNumber": "Watch7,1",
            "version": [
                {"type": {"coding": [{"system": MDC, "code": "531974"}]}, "value": "Watch7,1"},
                {"type": {"coding": [{"system": MDC, "code": "531975"}]}, "value": "11.0"},
                {"type": {"coding": [{"system": MDC, "code": "531976"}]}, "value": "1.2"},
            ],
        },
        watch_id,
    )
    app, app_id = _app_device(key)
    app_url = event.add(app, app_id)
    author_url = None
    if author_bundle:
        author_id = _snapshot(author_bundle, key)
        author_url = event.add(
            {
                "resourceType": "Device",
                "meta": {"profile": [HK_APPLICATION_DEVICE]},
                "identifier": [
                    author_id,
                    {
                        "type": {"coding": [{"system": HK_IDENTIFIER_TYPE, "code": "apple-bundle-id"}]},
                        "system": APPLE_BUNDLE_ID,
                        "value": author_bundle,
                    },
                ],
                "version": [{"type": {"coding": [{"system": MDC, "code": "531975"}]}, "value": "11.0"}],
            },
            author_id,
        )
    extensions: list[dict] = [{"url": HK_SOURCE_TYPE, "valueCode": sample_type}]
    if study_version is not None:
        plan = event.add(
            {
                "resourceType": "PlanDefinition",
                "url": DEFAULT_STUDY_PROTOCOL,
                "version": study_version,
                "status": "active",
            },
            event.node("plan-definition"),
        )
        study = event.add(
            {"resourceType": "ResearchStudy", "status": "active", "protocol": [{"reference": plan}]},
            event.node("research-study"),
        )
        extensions.append({"url": RESEARCH_STUDY_EXT, "valueReference": {"reference": study}})
    if recording_method:
        extensions.append(
            {"url": RECORDING_METHOD_EXT, "valueCoding": {"system": RECORDING_METHOD_SYSTEM, "code": recording_method}}
        )
    record = source_record(uid, sample_type, native, key)
    output = source_output(uid, sample_type, native, measurement, key)
    identifiers = [record, output, {"system": DEFAULT_NATIVE_RECORD_SYSTEM, "value": native}]
    if writer:
        identifiers.append(_opaque("writer-record", [APPLE_BUNDLE_ID, author_bundle or "app", writer[0]], key))
        extensions.append({"url": WRITER_VERSION, "valueString": writer[1]})
    observation: dict[str, Any] = {
        "resourceType": "Observation",
        "meta": {"profile": [MOBILE_SD + "grove-mobile-heart-rate"]},
        "identifier": identifiers,
        "extension": extensions,
        "status": status,
        "code": {"coding": [{"system": code[0], "code": code[1]}]},
        "subject": {"reference": patient},
        "device": {"reference": watch},
        **(effective or {"effectiveDateTime": "2026-08-20T08:30:00.251-07:00"}),
        **(
            value
            or {
                "valueQuantity": {
                    "value": 72,
                    "unit": "beats/minute",
                    "code": "/min",
                    "system": "http://unitsofmeasure.org",
                }
            }
        ),
    }
    obs_url = event.add(observation, output)
    entity: dict[str, Any] = {"role": "source", "what": {"identifier": record}}
    if author_url:
        entity["agent"] = [
            {"type": {"coding": [{"system": PARTICIPANT_TYPE, "code": "author"}]}, "who": {"reference": author_url}}
        ]
    event.add(
        {
            "resourceType": "Provenance",
            "meta": {"profile": [HK_CONVERSION_PROVENANCE]},
            "activity": {
                "coding": [{"system": "http://terminology.hl7.org/CodeSystem/iso-21089-lifecycle", "code": "transform"}]
            },
            "agent": [
                {"type": {"coding": [{"system": PARTICIPANT_TYPE, "code": "assembler"}]}, "who": {"reference": app_url}}
            ],
            "entity": [entity],
            "target": [{"reference": obs_url}],
            "occurredDateTime": recorded,
            "recorded": recorded,
        },
        event.node("conversion-provenance"),
    )
    return event.bundle("grove-mobile-exchange-bundle", recorded)


def hk_retraction(
    uid: str,
    native: str,
    *,
    sample_type: str = HR,
    measurement: str = "heart-rate",
    disclose_native: bool = True,
    seq: int = 2,
    key: GroveKey = PRODUCER_KEY,
    recorded: str = "2026-08-21T08:00:01Z",
) -> dict:
    """A retraction of one HealthKit record, naming its Observation output and disclosing the record id."""
    event = _Event(seq)
    target_ext = [{"url": MOBILE_SD + "grove-retraction-target-role", "valueCode": "primary-output"}]
    if disclose_native:
        target_ext.append(
            {
                "url": MOBILE_SD + "grove-retraction-target-native-identifier",
                "valueIdentifier": {"system": DEFAULT_NATIVE_RECORD_SYSTEM, "value": native},
            }
        )
    _, app_id = _app_device(key)
    event.add(
        {
            "resourceType": "Provenance",
            "meta": {"profile": [MOBILE_SD + "grove-mobile-retraction-provenance"]},
            "activity": {
                "coding": [
                    {
                        "system": "https://grovealliance.org/fhir/mobile/CodeSystem/grove-lifecycle-event",
                        "code": "source-record-retracted",
                    }
                ]
            },
            "agent": [
                {
                    "type": {"coding": [{"system": PARTICIPANT_TYPE, "code": "assembler"}]},
                    "who": {"type": "Device", "identifier": app_id},
                }
            ],
            "entity": [{"role": "source", "what": {"identifier": source_record(uid, sample_type, native, key)}}],
            "target": [
                {
                    "extension": target_ext,
                    "type": "Observation",
                    "identifier": source_output(uid, sample_type, native, measurement, key),
                }
            ],
            "occurredDateTime": recorded,
            "recorded": recorded,
        },
        event.node("retraction-provenance"),
    )
    return event.bundle("grove-mobile-retraction-bundle", recorded)


def native(n: int) -> str:
    return str(uuid.UUID(int=n, version=4)).upper()


def views(bundle: dict, uid: str, sample_type: str = HR, settings: Any = None) -> list:
    """ObservationViews of one event, through the parser and the HealthKit mapping."""
    from mhc_export.config import GroveSettings
    from mhc_export.grove.event import EventConfig, parse_event
    from mhc_export.grove.healthkit import views_from_event
    from mhc_export.transform.specs import default_registry

    settings = settings or GroveSettings()
    cfg = EventConfig(settings.deployment_root, settings.producer_namespaces, settings.participant_system)
    spec = default_registry().get(sample_type)
    return views_from_event(parse_event(bundle, cfg), uid=uid, spec=spec, settings=settings, warnings=[])


def observation(bundle: dict) -> dict:
    return next(e["resource"] for e in bundle["entry"] if e["resource"]["resourceType"] == "Observation")
