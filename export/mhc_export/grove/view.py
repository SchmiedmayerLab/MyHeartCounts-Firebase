# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""A flat, typed view over one HealthKit Observation in either the pre-Grove MHC shape or the Grove shape.

The pipeline reads a few dozen paths and nothing else, so this is deliberately not a FHIR model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

BDH = "https://bdh.stanford.edu/fhir/defs/"
MHC_STUDY = "https://myheartcounts.stanford.edu/fhir/StructureDefinition/study-enrollment"
HK_CODE_SYSTEM = "http://developer.apple.com/documentation/healthkit"

GROVE_ROLE_SYSTEM = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role"
GROVE_RECORDING_METHOD = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-recording-method"
GROVE_WRITER_VERSION = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-writer-record-version"
HK_SOURCE_TYPE = "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-source-type"
HK_MOTION_CONTEXT_SYSTEM = "https://grovealliance.org/fhir/healthkit/CodeSystem/healthkit-heart-rate-motion-context"
FHIR_TIMEZONE_URLS = (
    "http://hl7.org/fhir/StructureDefinition/timezone",
    "http://hl7.org/fhir/StructureDefinition/tz-code",
)
GROVE_MOBILE_PREFIX = "https://grovealliance.org/fhir/mobile/"
GROVE_HK_PREFIX = "https://grovealliance.org/fhir/healthkit/"
MDC_HARDWARE, MDC_SOFTWARE, MDC_FIRMWARE = "531974", "531975", "531976"

Shape = Literal["pre-grove", "grove"]


@dataclass(frozen=True)
class Effective:
    start: str
    end: str | None
    start_timezone: str | None = None


@dataclass(frozen=True)
class Quantity:
    value: Any
    unit: str | None
    code: str | None


@dataclass(frozen=True)
class Device:
    manufacturer: str | None = None
    model: str | None = None
    hardware: str | None = None
    software: str | None = None


@dataclass(frozen=True)
class SourceRevision:
    bundle_identifier: str | None = None
    version: str | None = None
    product_type: str | None = None
    os_version: str | None = None


@dataclass(frozen=True)
class ObservationView:
    shape: Shape
    resource_type: str
    sample_type: str | None
    native_uuid: str | None
    status: str | None
    effective: Effective | None
    issued: str | None
    quantity: Quantity | None
    category_raw: str | None
    value_code: str | None
    value_source_code: str | None
    device: Device | None
    source: SourceRevision | None
    upload_timezone: str | None
    sample_timezone: str | None
    study_revision: int | None
    app_version: str | None
    app_build: str | None
    sync_identifier: str | None
    sync_version: str | None
    was_user_entered: bool | None
    recording_method: str | None
    motion_context_raw: int | None
    identifiers: dict[str, tuple[str | None, str]] = field(default_factory=dict)
    duplicate_roles: tuple[str, ...] = ()
    is_clinical_record: bool = False


def _ext_list(obj: dict | None) -> list[dict]:
    if not obj:
        return []
    exts = obj.get("extension")
    return exts if isinstance(exts, list) else []


def _ext_value(ext: dict) -> Any:
    for key, val in ext.items():
        if key.startswith("value"):
            if key == "valueCoding" and isinstance(val, dict):
                return val.get("code")
            if key == "valueQuantity" and isinstance(val, dict):
                return val.get("value")
            return val
    return None


def _coding_code(concept: dict | None, system: str | None = None, prefix: str | None = None) -> str | None:
    if not concept:
        return None
    for coding in concept.get("coding") or []:
        if not isinstance(coding, dict):
            continue
        sys_ = coding.get("system") or ""
        if (system and sys_ == system) or (prefix and sys_.startswith(prefix)) or (system is None and prefix is None):
            return coding.get("code")
    return None


def _effective(resource: dict) -> Effective | None:
    if "effectiveDateTime" in resource:
        return Effective(resource["effectiveDateTime"], None, _timezone_ext(resource.get("_effectiveDateTime")))
    period = resource.get("effectivePeriod")
    if isinstance(period, dict) and period.get("start"):
        return Effective(period["start"], period.get("end"), _timezone_ext(period.get("_start")))
    if "effectiveInstant" in resource:
        return Effective(resource["effectiveInstant"], None, None)
    return None


def _timezone_ext(primitive: dict | None) -> str | None:
    for ext in _ext_list(primitive):
        if ext.get("url") in FHIR_TIMEZONE_URLS:
            return ext.get("valueCode") or ext.get("valueString")
    return None


def _quantity(resource: dict) -> Quantity | None:
    q = resource.get("valueQuantity")
    if not isinstance(q, dict):
        return None
    return Quantity(q.get("value"), q.get("unit"), q.get("code"))


def is_clinical_record_envelope(resource: dict) -> bool:
    return "resourceType" not in resource and "resource" in resource and "version" in resource


def parse_observation(resource: dict) -> ObservationView:
    if is_clinical_record_envelope(resource):
        return _empty("ClinicalRecordEnvelope", clinical=True)
    resource_type = resource.get("resourceType") or "<none>"
    if resource_type == "DocumentReference":
        return _empty(resource_type, clinical=True)
    identifiers, duplicate_roles = _grove_identifiers(resource)
    if identifiers:
        return _parse_grove(resource, resource_type, identifiers, duplicate_roles)
    return _parse_pre_grove(resource, resource_type)


def _empty(resource_type: str, *, clinical: bool) -> ObservationView:
    return ObservationView(
        shape="pre-grove",
        resource_type=resource_type,
        sample_type=None,
        native_uuid=None,
        status=None,
        effective=None,
        issued=None,
        quantity=None,
        category_raw=None,
        value_code=None,
        value_source_code=None,
        device=None,
        source=None,
        upload_timezone=None,
        sample_timezone=None,
        study_revision=None,
        app_version=None,
        app_build=None,
        sync_identifier=None,
        sync_version=None,
        was_user_entered=None,
        recording_method=None,
        motion_context_raw=None,
        is_clinical_record=clinical,
    )


def _grove_identifiers(resource: dict) -> tuple[dict[str, tuple[str | None, str]], tuple[str, ...]]:
    out: dict[str, tuple[str | None, str]] = {}
    duplicates: list[str] = []
    for ident in resource.get("identifier") or []:
        if not isinstance(ident, dict):
            continue
        role = _coding_code(ident.get("type"), system=GROVE_ROLE_SYSTEM)
        if role and ident.get("value"):
            if role in out:
                duplicates.append(role)
            out[role] = (ident.get("system"), ident["value"])
    return out, tuple(duplicates)


def _parse_pre_grove(resource: dict, resource_type: str) -> ObservationView:
    device = source = None
    metadata: dict[str, Any] = {}
    upload_tz = None
    study_revision = app_version = app_build = None
    for ext in _ext_list(resource):
        url = ext.get("url") or ""
        if url == BDH + "sourceDevice":
            vals = {e.get("url", "").rsplit("/", 1)[-1]: e.get("valueString") for e in _ext_list(ext)}
            device = Device(
                vals.get("manufacturer"), vals.get("model"), vals.get("hardwareVersion"), vals.get("softwareVersion")
            )
        elif url == BDH + "sourceRevision":
            vals: dict[str, Any] = {}
            for e in _ext_list(ext):
                key = e.get("url", "").rsplit("/", 1)[-1]
                if key == "source":
                    for inner in _ext_list(e):
                        vals[inner.get("url", "").rsplit("/", 1)[-1]] = inner.get("valueString")
                else:
                    vals[key] = e.get("valueString")
            source = SourceRevision(
                vals.get("bundleIdentifier"), vals.get("version"), vals.get("productType"), vals.get("OSVersion")
            )
        elif url == BDH + "metadata":
            for e in _ext_list(ext):
                metadata[e.get("url", "").rsplit("/", 1)[-1]] = _ext_value(e)
        elif url == BDH + "sampleUploadTimeZone":
            upload_tz = ext.get("valueString")
        elif url == MHC_STUDY:
            for e in _ext_list(ext):
                if e.get("url", "").endswith("/study-revision"):
                    study_revision = e.get("valueInteger")
        elif "app" in url.lower() and "revision" in url.lower():
            for e in _ext_list(ext):
                key = e.get("url", "").rsplit("/", 1)[-1].lower()
                if "build" in key:
                    app_build = str(_ext_value(e)) if _ext_value(e) is not None else None
                elif "version" in key:
                    app_version = str(_ext_value(e)) if _ext_value(e) is not None else None
            if app_version is None and ext.get("valueString"):
                app_version = ext["valueString"]
    sample_type = _coding_code(resource.get("code"), system=HK_CODE_SYSTEM)
    category_raw = _coding_code(resource.get("valueCodeableConcept"))
    sync_version = metadata.get("HKMetadataKeySyncVersion")
    user_entered = metadata.get("HKWasUserEntered")
    motion = metadata.get("HKMetadataKeyHeartRateMotionContext")
    return ObservationView(
        shape="pre-grove",
        resource_type=resource_type,
        sample_type=sample_type,
        native_uuid=resource.get("id") or _first_identifier_id(resource),
        status=resource.get("status"),
        effective=_effective(resource),
        issued=resource.get("issued"),
        quantity=_quantity(resource),
        category_raw=str(category_raw) if category_raw is not None else None,
        value_code=None,
        value_source_code=None,
        device=device,
        source=source,
        upload_timezone=upload_tz,
        sample_timezone=metadata.get("HKTimeZone") if isinstance(metadata.get("HKTimeZone"), str) else None,
        study_revision=int(study_revision) if isinstance(study_revision, int | float) else None,
        app_version=app_version,
        app_build=app_build,
        sync_identifier=metadata.get("HKMetadataKeySyncIdentifier")
        if isinstance(metadata.get("HKMetadataKeySyncIdentifier"), str)
        else None,
        sync_version=_decimal_text(sync_version),
        was_user_entered=_truthy(user_entered) if user_entered is not None else None,
        recording_method=None,
        motion_context_raw=_int_or_none(motion),
        identifiers={},
    )


def _first_identifier_id(resource: dict) -> str | None:
    for ident in resource.get("identifier") or []:
        if isinstance(ident, dict):
            return ident.get("value") or ident.get("id")
    return None


def _parse_grove(
    resource: dict,
    resource_type: str,
    identifiers: dict[str, tuple[str | None, str]],
    duplicate_roles: tuple[str, ...] = (),
) -> ObservationView:
    sample_type = recording_method = writer_version = None
    for ext in _ext_list(resource):
        url = ext.get("url")
        if url == HK_SOURCE_TYPE:
            sample_type = ext.get("valueCode")
        elif url == GROVE_RECORDING_METHOD:
            coding = ext.get("valueCoding") or {}
            recording_method = coding.get("code")
        elif url == GROVE_WRITER_VERSION:
            writer_version = ext.get("valueString")
    concept = resource.get("valueCodeableConcept")
    value_code = _coding_code(concept, prefix=GROVE_MOBILE_PREFIX)
    value_source_code = _coding_code(concept, prefix=GROVE_HK_PREFIX)
    motion = None
    for comp in resource.get("component") or []:
        code = _coding_code(comp.get("code"), prefix=GROVE_HK_PREFIX) or _coding_code(comp.get("code"))
        if code and "motion" in code.lower():
            motion_code = _coding_code(comp.get("valueCodeableConcept"), system=HK_MOTION_CONTEXT_SYSTEM)
            motion = {"not-set": 0, "sedentary": 1, "active": 2}.get(motion_code or "")
    native = None
    for ident in resource.get("identifier") or []:
        if (
            isinstance(ident, dict)
            and ident.get("value")
            and not _coding_code(ident.get("type"), system=GROVE_ROLE_SYSTEM)
        ):
            native = ident["value"]
    return ObservationView(
        shape="grove",
        resource_type=resource_type,
        sample_type=sample_type,
        native_uuid=native,
        status=resource.get("status"),
        effective=_effective(resource),
        issued=resource.get("issued"),
        quantity=_quantity(resource),
        category_raw=None,
        value_code=value_code,
        value_source_code=value_source_code,
        device=None,
        source=None,
        upload_timezone=None,
        sample_timezone=None,
        study_revision=None,
        app_version=None,
        app_build=None,
        sync_identifier=None,
        sync_version=writer_version,
        was_user_entered=None,
        recording_method=recording_method,
        motion_context_raw=motion,
        identifiers=identifiers,
        duplicate_roles=duplicate_roles,
    )


def device_from_resource(device: dict) -> Device:
    """Grove Recording Device -> descriptive fields."""
    hardware = software = None
    for version in device.get("version") or []:
        code = _coding_code(version.get("type"))
        if code == MDC_HARDWARE:
            hardware = version.get("value")
        elif code in (MDC_SOFTWARE, MDC_FIRMWARE):
            software = version.get("value")
    return Device(device.get("manufacturer"), device.get("modelNumber"), hardware, software)


def _decimal_text(value: Any) -> str | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value) if value >= 0 else None
    if isinstance(value, float) and value.is_integer():
        return str(int(value)) if value >= 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        return str(int(value))
    return None


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes")
    return False


def _int_or_none(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
