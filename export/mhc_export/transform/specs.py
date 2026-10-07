# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Per-sample-type specs: the Grove registry plus the Parquet contract."""

from __future__ import annotations

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
    ("source_bundle_hash", pa.string(), True),
    ("source_version", pa.string(), True),
    ("source_product_type", pa.string(), True),
    ("source_os_version", pa.string(), True),
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


@cache
def default_registry() -> Registry:
    return Registry.load()
