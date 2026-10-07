# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Per-sample-type specs: the Grove registry plus the Parquet contract."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from pathlib import Path

import pyarrow as pa

REGISTRY_PATH = Path(str(resources.files("mhc_export") / "schemas" / "healthkit-types.json"))

TIMESTAMP = pa.timestamp("us", tz="UTC")
TIMESTAMP_MS = pa.timestamp("ms", tz="UTC")

COMMON_COLUMNS: list[tuple[str, pa.DataType, bool]] = [
    ("sample_id", pa.string(), False),
    ("source_record_id", pa.string(), False),
    ("participant_id", pa.string(), False),
    ("sample_type", pa.string(), False),
    ("measurement_id", pa.string(), False),
    ("effective_start", TIMESTAMP, False),
    ("effective_end", TIMESTAMP, True),
    ("utc_offset_min", pa.int64(), True),
    ("timezone", pa.string(), True),
    ("value", pa.float64(), True),
    ("unit", pa.string(), True),
    ("value_code", pa.string(), True),
    ("value_source_code", pa.string(), True),
    ("recording_method", pa.string(), True),
    ("device_manufacturer", pa.string(), True),
    ("device_model", pa.string(), True),
    ("device_hardware", pa.string(), True),
    ("device_software", pa.string(), True),
    ("device_firmware", pa.string(), True),
    ("source_bundle_hash", pa.string(), True),
    ("source_version", pa.string(), True),
    ("app_version", pa.string(), True),
    ("app_build", pa.string(), True),
    ("study_revision", pa.int64(), True),
    ("writer_record_id", pa.string(), True),
    ("writer_version", pa.string(), True),
    ("converted_at", TIMESTAMP, True),
    ("upload_kind", pa.string(), False),
    ("from_archive", pa.bool_(), False),
    ("export_run_id", pa.string(), False),
    ("export_seq", pa.int64(), False),
]

EXTRA_COLUMNS: dict[str, list[tuple[str, pa.DataType]]] = {
    "HKQuantityTypeIdentifierHeartRate": [("motion_context", pa.string())],
}

EXPORTABLE_VALUE_KINDS = {"quantity", "codeableConcept"}


@dataclass(frozen=True)
class TypeSpec:
    sample_type: str
    status: str
    measurement_id: str | None
    value_kind: str | None
    unit: str | None
    integer_only: bool
    effective: str | None
    allowed_values: tuple[str, ...] | None
    minimum: tuple[float, bool] | None = None
    maximum: tuple[float, bool] | None = None
    code: tuple[str, str] | None = None
    value_system: str | None = None
    extra_columns: tuple[tuple[str, pa.DataType], ...] = field(default_factory=tuple)

    @property
    def exportable(self) -> bool:
        return self.status == "supported" and self.value_kind in EXPORTABLE_VALUE_KINDS

    @property
    def arrow_schema(self) -> pa.Schema:
        fields = [pa.field(name, dtype, nullable=nullable) for name, dtype, nullable in COMMON_COLUMNS]
        fields += [pa.field(name, dtype, nullable=True) for name, dtype in self.extra_columns]
        return pa.schema(
            fields, metadata={"sample_type": self.sample_type, "measurement_id": self.measurement_id or ""}
        )

    @property
    def column_names(self) -> list[str]:
        return [name for name, _, _ in COMMON_COLUMNS] + [name for name, _ in self.extra_columns]


class Registry:
    def __init__(self, raw: dict) -> None:
        self.grove_version: str = raw["grove_version"]
        self.generated_from: dict = raw["generated_from"]
        self.digest = _digest(raw)
        self._specs: dict[str, TypeSpec] = {}
        for sample_type, entry in raw["types"].items():
            self._specs[sample_type] = TypeSpec(
                sample_type=sample_type,
                status=entry["status"],
                measurement_id=entry.get("measurement_id"),
                value_kind=entry.get("value_kind"),
                unit=entry.get("unit"),
                integer_only=bool(entry.get("integer_only")),
                effective=entry.get("effective"),
                allowed_values=tuple(entry["allowed_values"]) if entry.get("allowed_values") else None,
                minimum=_bound(entry.get("minimum")),
                maximum=_bound(entry.get("maximum")),
                code=(entry["code"]["system"], entry["code"]["code"]) if entry.get("code") else None,
                value_system=entry.get("value_system"),
                extra_columns=tuple(EXTRA_COLUMNS.get(sample_type, [])),
            )

    @classmethod
    def load(cls, path: Path = REGISTRY_PATH) -> Registry:
        return cls(json.loads(path.read_text()))

    def get(self, sample_type: str) -> TypeSpec | None:
        return self._specs.get(sample_type)

    def __contains__(self, sample_type: str) -> bool:
        return sample_type in self._specs

    def exportable_types(self) -> list[str]:
        return sorted(t for t, s in self._specs.items() if s.exportable)


def _bound(raw: dict | None) -> tuple[float, bool] | None:
    if not raw or raw.get("value") is None:
        return None
    return float(raw["value"]), bool(raw.get("inclusive", True))


def _digest(raw: dict) -> str:
    return hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@cache
def default_registry() -> Registry:
    return Registry.load()


COVERAGE_PATH = Path(str(resources.files("mhc_export") / "schemas" / "coverage.json"))


@dataclass(frozen=True)
class Disposition:
    disposition: str  # export | deferred | excluded
    reason: str

    @property
    def exported(self) -> bool:
        return self.disposition == "export"

    @property
    def label(self) -> str:
        return f"{self.disposition}:{self.reason}"


class Coverage:
    """Which HealthKit types version 1 exports, decided against the study definition; everything else is skipped."""

    def __init__(self, raw: dict) -> None:
        self.digest = _digest(raw)
        self.source: dict = raw.get("source") or {}
        default = raw.get("default") or {"disposition": "excluded", "reason": "not_in_study"}
        self._default = Disposition(default["disposition"], default["reason"])
        self._types = {t: Disposition(v["disposition"], v["reason"]) for t, v in (raw.get("types") or {}).items()}

    @classmethod
    def load(cls, path: Path = COVERAGE_PATH) -> Coverage:
        return cls(json.loads(path.read_text()))

    def of(self, sample_type: str) -> Disposition:
        return self._types.get(sample_type, self._default)

    def exported_types(self) -> list[str]:
        return sorted(t for t, d in self._types.items() if d.exported)


@cache
def default_coverage() -> Coverage:
    return Coverage.load()
