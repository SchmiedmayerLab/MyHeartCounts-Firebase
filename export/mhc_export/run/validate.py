# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Validation of a compacted run against the contract and the run report. A failed check blocks promotion."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, Field

from mhc_export.run.compact import list_compacted
from mhc_export.run.models import Unit
from mhc_export.transform.specs import COMMON_COLUMNS, Registry, TypeSpec, default_registry

log = logging.getLogger(__name__)

GROVE_ID_RE = r"^v0:[^:]+:[0-9]+:[A-Za-z0-9_-]{43}$"
ID_COLUMNS = {"sample_id", "source_record_id", "participant_id", "source_bundle_hash", "writer_record_id"}
PHI_PATTERNS: dict[str, str] = {
    "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "phone": (
        r"(^|[^0-9])(\+[0-9][0-9 ()-]{8,}[0-9]|\([0-9]{3}\) ?[0-9]{3}[ .-]?[0-9]{4}"
        r"|[0-9]{3}[ .-][0-9]{3,4}[ .-][0-9]{4})([^0-9]|$)"
    ),
    "possessive_name": r"(?i)\b[a-z]+['’](s\b|\s)|\b(von|de|di|van|of|für|pour|para)\s+[A-Z][a-z]+",
    "uuid": r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    "source_bundle_uuid": r"(?i)com\.apple\.health\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
}
SAMPLE_SEED = 42


class Check(BaseModel):
    name: str
    sample_type: str | None = None
    ok: bool
    detail: str = ""


class ValidationReport(BaseModel):
    run_id: str
    ok: bool
    checks: list[Check] = Field(default_factory=list)
    rows_total: int = 0
    files: int = 0
    compacted_digest: str = ""
    report_digest: str = ""
    seconds: float = 0.0

    def failures(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]


def compacted_fingerprint(compacted_root: Path) -> tuple[str, list[dict]]:
    """Digest over (relative path, bytes, rows) of every compacted file; binds a validation to a file set."""
    entries: list[dict] = []
    for sample_type, year, month, files in list_compacted(compacted_root):
        for path in sorted(files):
            rel = f"{sample_type}/year={year:04d}/month={month:02d}/{path.name}"
            entries.append({"path": rel, "bytes": path.stat().st_size, "rows": pq.read_metadata(path).num_rows})
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
    return digest, entries


def _expected_rows_by_type(run_report: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for unit_id, result in (run_report.get("units") or {}).items():
        if "error" in result or result.get("skipped_reason"):
            continue
        sample_type = unit_id.split(":", 1)[1]
        out[sample_type] = out.get(sample_type, 0) + int(result.get("rows_out", 0))
    return out


def _warning_total(run_report: dict, sample_type: str, warning: str) -> int:
    total = 0
    for unit_id, result in (run_report.get("units") or {}).items():
        if unit_id.endswith(":" + sample_type):
            total += int((result.get("warnings") or {}).get(warning, 0))
    return total


def report_digest(run_report: dict) -> str:
    return hashlib.sha256(json.dumps(run_report, sort_keys=True, default=str).encode()).hexdigest()


def run_complete_check(run_report: dict, run_id: str, manifest: list[Unit] | None = None) -> Check:
    """The run covered every planned unit: no filter, no failures, and the unit set equals the manifest's."""
    summary = run_report.get("report") or {}
    units = run_report.get("units") or {}
    errored = [u for u, r in units.items() if "error" in r]
    problems: list[str] = []
    if summary.get("run_id") != run_id:
        problems.append(f"report run_id {summary.get('run_id')!r} != {run_id!r}")
    if summary.get("filtered"):
        problems.append("report comes from a filtered (subset) run")
    if int(summary.get("units_failed", 0) or 0) or errored:
        problems.append(f"{max(int(summary.get('units_failed', 0) or 0), len(errored))} units failed")
    if int(summary.get("units_done", -1)) != int(summary.get("units_total", -2)):
        problems.append(f"{summary.get('units_done')} of {summary.get('units_total')} units done")
    planned = summary.get("planned_units")
    if planned is not None and int(planned) != int(summary.get("units_total", -1)):
        problems.append(f"{summary.get('units_total')} units worked of {planned} planned")
    if manifest is not None:
        expected_ids = {u.unit_id for u in manifest}
        if set(units) != expected_ids:
            missing = sorted(expected_ids - set(units))[:3]
            extra = sorted(set(units) - expected_ids)[:3]
            problems.append(f"unit set differs from manifest (missing {missing}, extra {extra})")
    return Check(name="run_complete", ok=not problems, detail="; ".join(problems))


def _schema_check(files: list[Path], spec: TypeSpec) -> Check:
    expected = spec.arrow_schema
    for path in files:
        actual = pq.read_schema(path)
        if actual.names != expected.names:
            return Check(
                name="schema", sample_type=spec.sample_type, ok=False, detail=f"{path.name}: columns {actual.names}"
            )
        for name in expected.names:
            if not actual.field(name).type.equals(expected.field(name).type):
                return Check(
                    name="schema",
                    sample_type=spec.sample_type,
                    ok=False,
                    detail=f"{path.name}: {name} is {actual.field(name).type}, expected {expected.field(name).type}",
                )
    return Check(name="schema", sample_type=spec.sample_type, ok=True, detail=f"{len(files)} files")


def _glob(compacted_root: Path, sample_type: str) -> str:
    return str(compacted_root / sample_type / "year=*" / "month=*" / "part-*.parquet")


def validate_run(
    compacted_root: Path,
    run_report: dict,
    *,
    run_id: str,
    uids: set[str],
    registry: Registry | None = None,
    sample_rows: int = 200_000,
    manifest: list[Unit] | None = None,
) -> ValidationReport:
    started = time.monotonic()
    registry = registry or default_registry()
    report = ValidationReport(run_id=run_id, ok=True, report_digest=report_digest(run_report))
    report.checks.append(run_complete_check(run_report, run_id, manifest))
    expected = _expected_rows_by_type(run_report)
    con = duckdb.connect()
    con.execute("set TimeZone = 'UTC'")
    present: dict[str, list[Path]] = {}
    for sample_type, _, _, files in list_compacted(compacted_root):
        present.setdefault(sample_type, []).extend(files)
    report.compacted_digest, entries = compacted_fingerprint(compacted_root)
    report.files = len(entries)

    for sample_type, rows in sorted(expected.items()):
        if rows > 0 and sample_type not in present:
            report.checks.append(Check(name="present", sample_type=sample_type, ok=False, detail="no compacted files"))
    for sample_type in sorted(set(present) - set(expected)):
        report.checks.append(
            Check(
                name="present",
                sample_type=sample_type,
                ok=False,
                detail="compacted files for a type the report does not contain",
            )
        )

    non_null = [name for name, _, nullable in COMMON_COLUMNS if not nullable]
    for sample_type, files in sorted(present.items()):
        spec = registry.get(sample_type)
        if spec is None:
            report.checks.append(Check(name="known_type", sample_type=sample_type, ok=False))
            continue
        schema_check = _schema_check(files, spec)
        report.checks.append(schema_check)
        if not schema_check.ok:
            continue
        glob = _glob(compacted_root, sample_type)
        null_exprs = ", ".join(f'count(*) filter (where "{c}" is null)' for c in non_null)
        try:
            row = _type_stats(con, glob, null_exprs)
        except duckdb.Error as exc:
            report.checks.append(Check(name="query", sample_type=sample_type, ok=False, detail=str(exc)[:300]))
            continue
        assert row is not None
        total, distinct_ids = row[0], row[1]
        nulls = dict(zip(non_null, row[2 : 2 + len(non_null)], strict=True))
        value_nulls, code_nulls, bad_ids, bad_hashes, bad_partition, bad_period, participants = row[2 + len(non_null) :]
        report.rows_total += total
        exp = expected.get(sample_type)
        report.checks.append(
            Check(
                name="row_count", sample_type=sample_type, ok=exp == total, detail=f"{total} compacted, {exp} in report"
            )
        )
        report.checks.append(
            Check(
                name="unique_sample_id",
                sample_type=sample_type,
                ok=distinct_ids == total,
                detail=f"{total - distinct_ids} duplicates",
            )
        )
        bad_nulls = {c: n for c, n in nulls.items() if n}
        report.checks.append(
            Check(
                name="required_not_null",
                sample_type=sample_type,
                ok=not bad_nulls,
                detail=str(bad_nulls) if bad_nulls else "",
            )
        )
        if spec.value_kind == "quantity":
            allowed = _warning_total(run_report, sample_type, "non_finite_value")
            report.checks.append(
                Check(
                    name="value_nulls",
                    sample_type=sample_type,
                    ok=value_nulls <= allowed,
                    detail=f"{value_nulls} null values, {allowed} non-finite reported",
                )
            )
        else:
            report.checks.append(
                Check(
                    name="value_code_nulls",
                    sample_type=sample_type,
                    ok=code_nulls == 0,
                    detail=f"{code_nulls} null codes",
                )
            )
        report.checks.append(
            Check(
                name="id_format",
                sample_type=sample_type,
                ok=bad_ids == 0 and bad_hashes == 0,
                detail=f"{bad_ids} ids, {bad_hashes} hashes",
            )
        )
        report.checks.append(
            Check(
                name="partition",
                sample_type=sample_type,
                ok=bad_partition == 0,
                detail=f"{bad_partition} rows outside their partition",
            )
        )
        report.checks.append(
            Check(
                name="period_order",
                sample_type=sample_type,
                ok=bad_period == 0,
                detail=f"{bad_period} rows end before start",
            )
        )
        leaked = sorted(set(participants or []) & uids)
        report.checks.append(
            Check(
                name="participant_not_uid",
                sample_type=sample_type,
                ok=not leaked,
                detail=f"{len(leaked)} uids exported" if leaked else "",
            )
        )
        report.checks.append(_phi_scan(con, glob, spec, sample_rows, total))

    report.ok = all(c.ok for c in report.checks)
    report.seconds = time.monotonic() - started
    return report


def _type_stats(con: duckdb.DuckDBPyConnection, glob: str, null_exprs: str) -> tuple | None:
    return con.execute(
        f"""
        select count(*), count(distinct sample_id), {null_exprs},
               count(*) filter (where value is null), count(*) filter (where value_code is null),
               count(*) filter (where sample_id !~ '{GROVE_ID_RE}' or source_record_id !~ '{GROVE_ID_RE}'),
               count(*) filter (where source_bundle_hash is not null and source_bundle_hash !~ '{GROVE_ID_RE}')
                 + count(*) filter (where writer_record_id is not null and writer_record_id !~ '{GROVE_ID_RE}'),
               count(*) filter (where strftime(effective_start, '%Y')::int != year
                                   or strftime(effective_start, '%m')::int != month),
               count(*) filter (where effective_end is not null and effective_end < effective_start),
               list(distinct participant_id)
        from read_parquet('{glob}', hive_partitioning = true, hive_types = {{'year': int, 'month': int}})
        """
    ).fetchone()


def _phi_scan(con: duckdb.DuckDBPyConnection, glob: str, spec: TypeSpec, sample_rows: int, total_rows: int) -> Check:
    """One query per type over a system sample spread across every file, or every row when the type is small."""
    string_columns = [f.name for f in spec.arrow_schema if f.type == pa.string() and f.name not in ID_COLUMNS]
    if not string_columns or total_rows == 0:
        return Check(name="phi_scan", sample_type=spec.sample_type, ok=True, detail="nothing to scan")
    labels: list[str] = []
    exprs: list[str] = []
    params: list[str] = []
    for column in string_columns:
        for label, pattern in PHI_PATTERNS.items():
            labels.append(f"{column}:{label}")
            exprs.append(f'count(*) filter (where "{column}" is not null and regexp_matches("{column}", ?))')
            params.append(pattern)
    columns = ", ".join(f'"{c}"' for c in string_columns)
    sample = ""
    if total_rows > sample_rows:
        percent = max(1, math.ceil(100 * sample_rows / total_rows))
        sample = f" using sample {percent} percent (system, {SAMPLE_SEED})"
    query = f"select count(*), {', '.join(exprs)} from (select {columns} from read_parquet('{glob}'){sample})"
    row = con.execute(query, params).fetchone()
    assert row is not None
    scanned = int(row[0])
    floor = min(total_rows, sample_rows // 2)
    if sample and scanned < floor:
        # a vector-level system sample can come back nearly empty on small or skewed inputs: scan everything instead
        row = con.execute(query.replace(sample, ""), params).fetchone()
        assert row is not None
        scanned = int(row[0])
        sample = ""
    hits = {label: int(n) for label, n in zip(labels, row[1:], strict=True) if n}
    coverage = f"{scanned} rows sampled" if sample else f"all {scanned} rows"
    detail = str(hits) if hits else f"{len(string_columns)} columns clean, {coverage}"
    return Check(name="phi_scan", sample_type=spec.sample_type, ok=not hits, detail=detail)
