# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""ObservationView + TypeSpec -> one Parquet row. Pure; raises ProjectError with a stable reason code."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from mhc_export.config import IdentityConfig
from mhc_export.grove.view import ObservationView
from mhc_export.identity.grove_ids import HealthKitIdentity, IdentityError, opaque_identity
from mhc_export.run.models import UploadKind
from mhc_export.transform.category_values import HEART_RATE_MOTION_CONTEXT, CategoryValueError, category_value
from mhc_export.transform.specs import TypeSpec
from mhc_export.transform.timeparse import TimeParseError, parse_instant, zone_matches_offset
from mhc_export.transform.units import UnitError, convert, ucum_code

GROVE_ID_PATTERN = re.compile(r"v0:[^:]+:[1-9][0-9]*:[A-Za-z0-9_-]{43}")
CANONICAL_DECIMAL = re.compile(r"0|[1-9][0-9]*")
APPLE_BUNDLE_ID_SYSTEM = "https://grovealliance.org/fhir/healthkit/NamingSystem/apple-bundle-id"


class ProjectError(ValueError):
    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


@dataclass(frozen=True)
class ProjectContext:
    participant_id: str
    identity: HealthKitIdentity
    run_id: str
    upload_kind: UploadKind
    from_archive: bool
    config: IdentityConfig | None = None


@dataclass(frozen=True)
class Projected:
    row: dict[str, Any]
    warnings: tuple[str, ...]


def project(view: ObservationView, spec: TypeSpec, ctx: ProjectContext, seq: int) -> Projected:
    warnings: list[str] = []
    if view.is_clinical_record:
        raise ProjectError("clinical_record")
    if view.resource_type != "Observation":
        raise ProjectError("not_observation", view.resource_type)
    if view.status != "final":
        raise ProjectError("non_final", str(view.status))
    if view.sample_type and view.sample_type != spec.sample_type:
        raise ProjectError("sample_type_mismatch", f"{view.sample_type} in {spec.sample_type} unit")
    if not spec.exportable or spec.measurement_id is None:
        raise ProjectError("unsupported_type", spec.sample_type)

    sample_id, source_record_id = _identities(view, spec, ctx)
    start_ms, end_ms, offset_min, timezone = _times(view, spec, warnings)

    value = unit = value_code = value_source_code = None
    if spec.value_kind == "quantity":
        value, unit = _quantity(view, spec)
    else:
        value_code, value_source_code = _category(view, spec)

    writer_record_id, writer_version = _writer(view, ctx, warnings)
    device = view.device
    source = view.source
    row: dict[str, Any] = {
        "sample_id": sample_id,
        "source_record_id": source_record_id,
        "participant_id": ctx.participant_id,
        "sample_type": spec.sample_type,
        "measurement_id": spec.measurement_id,
        "effective_start": start_ms,
        "effective_end": end_ms,
        "utc_offset_min": offset_min,
        "timezone": timezone,
        "value": value,
        "unit": unit,
        "value_code": value_code,
        "value_source_code": value_source_code,
        "recording_method": _recording_method(view),
        "device_manufacturer": device.manufacturer if device else None,
        "device_model": device.model if device else None,
        "device_hardware": device.hardware if device else None,
        "device_software": device.software if device else None,
        "source_bundle_hash": _source_bundle_hash(view, ctx),
        "source_version": source.version if source else None,
        "source_product_type": source.product_type if source else None,
        "source_os_version": source.os_version if source else None,
        "app_version": view.app_version,
        "app_build": view.app_build,
        "study_revision": view.study_revision,
        "writer_record_id": writer_record_id,
        "writer_version": writer_version,
        "converted_at": _converted_at(view),
        "upload_kind": ctx.upload_kind.value,
        "from_archive": ctx.from_archive,
        "export_run_id": ctx.run_id,
        "export_seq": seq,
    }
    for name, _ in spec.extra_columns:
        row[name] = _extra(name, view)
    return Projected(row, tuple(warnings))


def _identities(view: ObservationView, spec: TypeSpec, ctx: ProjectContext) -> tuple[str, str]:
    if view.shape == "grove":
        if view.duplicate_roles:
            raise ProjectError("duplicate_grove_identity", ",".join(view.duplicate_roles))
        out = view.identifiers.get("source-output")
        rec = view.identifiers.get("source-record")
        if not (out and rec):
            raise ProjectError("missing_grove_identity")
        for role, (system, value) in (("source-output", out), ("source-record", rec)):
            _check_namespace(ctx, role, system, value)
        return out[1], rec[1]
    if not view.native_uuid:
        raise ProjectError("missing_uuid")
    try:
        return (
            ctx.identity.source_output(spec.sample_type, view.native_uuid, spec.measurement_id or ""),
            ctx.identity.source_record(spec.sample_type, view.native_uuid),
        )
    except IdentityError as exc:
        raise ProjectError("bad_uuid", str(exc)) from exc


def _check_namespace(ctx: ProjectContext, role: str, system: str | None, value: str) -> None:
    """A Grove identity is accepted only under this deployment's identifier system and an accepted key epoch."""
    config = ctx.config
    if config is None:
        return
    if not GROVE_ID_PATTERN.fullmatch(value):
        raise ProjectError("bad_grove_identity", f"{role} value is not a v0 Grove identity")
    if not any(value.startswith(prefix) for prefix in config.accepted_prefixes()):
        raise ProjectError("foreign_identity", f"{role} value under an unknown key or epoch")
    if system not in config.accepted_systems(role):
        raise ProjectError("foreign_identity", f"{role} system {system!r} is not this deployment's")


def _times(
    view: ObservationView, spec: TypeSpec, warnings: list[str]
) -> tuple[int, int | None, int | None, str | None]:
    if view.effective is None:
        raise ProjectError("missing_effective")
    try:
        start_ms, offset_min = parse_instant(view.effective.start)
        end_ms = parse_instant(view.effective.end)[0] if view.effective.end else None
    except TimeParseError as exc:
        raise ProjectError("bad_time", str(exc)) from exc
    if end_ms is not None and end_ms < start_ms:
        raise ProjectError("bad_time", "end before start")
    if spec.effective == "Period" and end_ms is None:
        warnings.append("period_expected")
    elif spec.effective == "dateTime" and end_ms is not None and end_ms != start_ms:
        warnings.append("instant_expected")
    timezone = None
    for candidate in (view.effective.start_timezone, view.sample_timezone, view.upload_timezone):
        if candidate and zone_matches_offset(candidate, start_ms, offset_min):
            timezone = candidate
            break
    return start_ms, end_ms, offset_min, timezone


def _quantity(view: ObservationView, spec: TypeSpec) -> tuple[float, str]:
    assert spec.unit is not None
    q = view.quantity
    if q is None:
        raise ProjectError("missing_value")
    raw = q.value
    if isinstance(raw, bool):
        raise ProjectError("bad_value", "boolean")
    if isinstance(raw, int | float):
        value = float(raw)
    elif isinstance(raw, str):
        try:
            value = float(raw.strip())
        except ValueError as exc:
            raise ProjectError("bad_value", raw) from exc
    else:
        raise ProjectError("bad_value", type(raw).__name__)
    if math.isnan(value) or math.isinf(value):
        raise ProjectError("non_finite_value")
    try:
        source_unit = ucum_code(q.unit, q.code)
        if view.shape == "pre-grove" and source_unit == "%":
            # HealthKit's percent unit is a 0-1 fraction; Grove's '%' is percentage points
            value *= 100.0
        value = convert(value, source_unit, spec.unit)
    except UnitError as exc:
        raise ProjectError("bad_unit", str(exc)) from exc
    if not math.isfinite(value):
        raise ProjectError("non_finite_value", "after unit conversion")
    if spec.integer_only and not value.is_integer():
        raise ProjectError("out_of_domain", f"{value} is not integral")
    if spec.minimum is not None:
        low, inclusive = spec.minimum
        if value < low or (value == low and not inclusive):
            raise ProjectError("out_of_domain", f"{value} below {low}")
    if spec.maximum is not None:
        high, inclusive = spec.maximum
        if value > high or (value == high and not inclusive):
            raise ProjectError("out_of_domain", f"{value} above {high}")
    return value, spec.unit


def _category(view: ObservationView, spec: TypeSpec) -> tuple[str, str | None]:
    if view.shape == "grove":
        if view.value_code is None:
            raise ProjectError("missing_value")
        code, source_code = view.value_code, view.value_source_code
    else:
        try:
            source_code, code = category_value(spec.sample_type, view.category_raw)
        except CategoryValueError as exc:
            raise ProjectError("bad_value", str(exc)) from exc
    if spec.allowed_values and code not in spec.allowed_values:
        raise ProjectError("bad_value", f"{code} not in allowed values")
    return code, source_code


def _writer(view: ObservationView, ctx: ProjectContext, warnings: list[str]) -> tuple[str | None, str | None]:
    if view.shape == "grove":
        writer = view.identifiers.get("writer-record")
        if writer:
            _check_namespace(ctx, "writer-record", writer[0], writer[1])
        version = view.sync_version
        if version is not None and not CANONICAL_DECIMAL.fullmatch(version):
            raise ProjectError("bad_writer_version", f"{version!r} is not a canonical unsigned decimal")
        if (writer is None) != (version is None):
            raise ProjectError("bad_writer_version", "writer identity and version must come as a pair")
        return (writer[1] if writer else None), version
    has_id, has_version = bool(view.sync_identifier), view.sync_version is not None
    if has_id != has_version:
        warnings.append("writer_half_pair")
        return None, None
    if not has_id:
        return None, None
    bundle = view.source.bundle_identifier if view.source else None
    if not bundle:
        warnings.append("writer_without_bundle")
        return None, None
    try:
        writer_id = opaque_identity(
            ctx.identity.key, "writer-record", [APPLE_BUNDLE_ID_SYSTEM, bundle, view.sync_identifier or ""]
        )
    except IdentityError:
        warnings.append("writer_half_pair")
        return None, None
    return writer_id, view.sync_version


def _source_bundle_hash(view: ObservationView, ctx: ProjectContext) -> str | None:
    bundle = view.source.bundle_identifier if view.source else None
    if not bundle:
        return None
    try:
        return opaque_identity(
            ctx.identity.key,
            "recording-device",
            [HealthKitIdentity.ADAPTER_ID, ctx.identity.scope.system, ctx.identity.scope.value, bundle],
        )
    except IdentityError:
        return None


def _recording_method(view: ObservationView) -> str | None:
    if view.recording_method:
        return view.recording_method
    if view.was_user_entered:
        return "manual-entry"
    return None


def _converted_at(view: ObservationView) -> int | None:
    if not view.issued:
        return None
    try:
        return parse_instant(view.issued)[0]
    except TimeParseError:
        return None


def _extra(name: str, view: ObservationView) -> Any:
    if name == "motion_context":
        return HEART_RATE_MOTION_CONTEXT.get(view.motion_context_raw) if view.motion_context_raw is not None else None
    return None
