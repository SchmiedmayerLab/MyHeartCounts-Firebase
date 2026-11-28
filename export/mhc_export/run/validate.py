# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Validation of a compacted run against the contract and the run report. A failed check blocks promotion."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, Field

from mhc_export.run.compact import TOUCHED_NAME, list_compacted, list_type_months, partition_key, read_touched
from mhc_export.run.envelope import RunEnvelope, envelope_digest
from mhc_export.run.inputs import RunInputs, staged_partitions
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
    envelope_sha256: str = ""
    base_dataset_sha256: str | None = None
    entries: list[dict] = Field(default_factory=list)
    seconds: float = 0.0

    def failures(self) -> list[Check]:
        return [c for c in self.checks if not c.ok]


def file_md5(path: Path) -> str:
    digest = hashlib.md5()  # noqa: S324 - integrity only, matches the GCS object checksum
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compacted_fingerprint(compacted_root: Path) -> tuple[str, list[dict]]:
    """Digest over (relative path, bytes, rows, md5) of every compacted file; binds a validation to file contents."""
    entries: list[dict] = []
    for sample_type, year, month, files in list_compacted(compacted_root):
        for path in sorted(files):
            rel = f"{sample_type}/year={year:04d}/month={month:02d}/{path.name}"
            entries.append(
                {
                    "path": rel,
                    "bytes": path.stat().st_size,
                    "rows": pq.read_metadata(path).num_rows,
                    "md5": file_md5(path),
                }
            )
    touched_path = compacted_root / TOUCHED_NAME
    touched = json.loads(touched_path.read_text()) if touched_path.is_file() else None
    digest = hashlib.sha256(json.dumps({"files": entries, "touched": touched}, sort_keys=True).encode()).hexdigest()
    return digest, entries


def _expected_rows_by_type(run_report: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for unit_id, result in (run_report.get("units") or {}).items():
        if "error" in result or result.get("skipped_reason"):
            continue
        sample_type = unit_id.split(":")[1]
        out[sample_type] = out.get(sample_type, 0) + int(result.get("rows_out", 0))
    return out


def _paths(files: list[Path]) -> str:
    return "[" + ", ".join(f"'{p}'" for p in files) + "]"


def _reconciliation_checks(
    con: duckdb.DuckDBPyConnection, compacted_root: Path, run_report: dict, inputs: RunInputs
) -> list[Check]:
    """Recompute every rebuilt partition from the run's inputs, independently of compaction's own arithmetic."""
    checks: list[Check] = []
    try:
        touched = read_touched(compacted_root)
    except FileNotFoundError as exc:
        return [Check(name="touched", ok=False, detail=str(exc))]
    keys = set(touched.get("partitions") or [])
    if touched.get("base_dataset_sha256") != inputs.base_dataset_sha256:
        checks.append(Check(name="base_version", ok=False, detail="compaction ran against a different lake version"))
    staged = {partition_key(*p) for p in staged_partitions(inputs.staging_root)}
    missing = sorted(staged - keys)
    checks.append(
        Check(name="touched_covers_staged", ok=not missing, detail=f"untouched staged partitions {missing[:3]}")
    )

    staged_rows: dict[str, int] = {}
    staged_files: dict[str, list[Path]] = {}
    for tm in list_type_months(inputs.staging_root):
        staged_files[partition_key(tm.sample_type, tm.year, tm.month)] = list(tm.parts)
        staged_rows[tm.sample_type] = staged_rows.get(tm.sample_type, 0) + sum(
            pq.read_metadata(p).num_rows for p in tm.parts
        )
    expected = _expected_rows_by_type(run_report)
    for sample_type in sorted(set(expected) | set(staged_rows)):
        got, want = staged_rows.get(sample_type, 0), expected.get(sample_type, 0)
        checks.append(
            Check(
                name="staging_matches_report",
                sample_type=sample_type,
                ok=got == want,
                detail=f"{got} staged, {want} in report",
            )
        )

    compacted_files = {partition_key(t, y, m): files for t, y, m, files in list_compacted(compacted_root)}
    committed_by_key = {partition_key(*p): files for p, files in inputs.committed.items()}
    for key in sorted(keys):
        sample_type = key.split("/", 1)[0]
        sources = [*staged_files.get(key, []), *committed_by_key.get(key, [])]
        ledger = inputs.ledger.get(sample_type, [])
        expected_rows = 0
        if sources:
            exclusion = (
                f"where sample_id not in (select sample_id from read_parquet({_paths(ledger)}))" if ledger else ""
            )
            source_sql = f"read_parquet({_paths(sources)}, union_by_name = true)"
            row = con.execute(f"select count(distinct sample_id) from {source_sql} {exclusion}").fetchone()
            expected_rows = int(row[0]) if row else 0
        files = compacted_files.get(key, [])
        actual = sum(pq.read_metadata(p).num_rows for p in files)
        checks.append(
            Check(
                name="partition_rows",
                sample_type=sample_type,
                ok=actual == expected_rows,
                detail=f"{key}: {actual} rows, {expected_rows} expected",
            )
        )
        if files and ledger:
            leaked = con.execute(
                f"select count(*) from read_parquet({_paths(files)}) "
                f"where sample_id in (select sample_id from read_parquet({_paths(ledger)}))"
            ).fetchone()
            n = int(leaked[0]) if leaked else 0
            checks.append(
                Check(
                    name="retractions_applied",
                    sample_type=sample_type,
                    ok=n == 0,
                    detail=f"{key}: {n} retracted rows present",
                )
            )

    for (sample_type, year, month), files in sorted(inputs.committed.items()):
        key = partition_key(sample_type, year, month)
        fresh = inputs.fresh_ledger.get(sample_type)
        if key in keys or not fresh or not files:
            continue
        hit = con.execute(
            f"select count(*) from read_parquet({_paths(files)}) "
            f"where sample_id in (select sample_id from read_parquet({_paths(fresh)}))"
        ).fetchone()
        n = int(hit[0]) if hit else 0
        checks.append(
            Check(
                name="retractions_applied",
                sample_type=sample_type,
                ok=n == 0,
                detail=f"{key} (untouched): {n} retracted rows",
            )
        )
    return checks


def _accepted_prefixes(run_report: dict) -> list[str]:
    identity = (run_report.get("report") or {}).get("identity") or {}
    epochs = identity.get("accepted_epochs") or []
    return [f"v0:{e}:" for e in epochs if isinstance(e, str) and e]


def _unit_total(run_report: dict, sample_type: str, field: str) -> int:
    total = 0
    for unit_id, result in (run_report.get("units") or {}).items():
        if unit_id.endswith(":" + sample_type):
            total += int(result.get(field, 0) or 0)
    return total


def report_digest(run_report: dict) -> str:
    return hashlib.sha256(json.dumps(run_report, sort_keys=True, default=str).encode()).hexdigest()


def run_complete_check(
    run_report: dict,
    run_id: str,
    manifest: list[Unit] | None = None,
    envelope: RunEnvelope | None = None,
    manifest_digest: str | None = None,
) -> Check:
    """The run covered every planned unit: no filter, no failures, the unit set equals the manifest's, and the
    report, manifest and envelope belong together."""
    summary = run_report.get("report") or {}
    units = run_report.get("units") or {}
    errored = [u for u, r in units.items() if "error" in r]
    problems: list[str] = []
    if summary.get("run_id") != run_id:
        problems.append(f"report run_id {summary.get('run_id')!r} != {run_id!r}")
    if envelope is not None:
        if envelope.run_id != run_id:
            problems.append(f"envelope run_id {envelope.run_id!r} != {run_id!r}")
        if summary.get("envelope_sha256") != envelope_digest(envelope):
            problems.append("the report was produced from a different run envelope")
        if manifest is not None and envelope.unit_count != len(manifest):
            problems.append(f"envelope lists {envelope.unit_count} units, manifest has {len(manifest)}")
        if manifest_digest is not None and envelope.manifest_sha256 != manifest_digest:
            problems.append("the manifest changed after planning")
    if summary.get("filtered"):
        problems.append("report comes from a filtered (subset) run")
    if int(summary.get("units_failed", 0) or 0) or errored:
        problems.append(f"{max(int(summary.get('units_failed', 0) or 0), len(errored))} units failed")
    fatal_total = sum(sum((r.get("fatal") or {}).values()) for r in units.values())
    tolerated = int(summary.get("tolerated_fatal", 0) or 0)
    if fatal_total > tolerated:
        problems.append(f"{fatal_total} fatal input errors, {tolerated} tolerated")
    if int(summary.get("units_done", -1)) != int(summary.get("units_total", -2)):
        problems.append(f"{summary.get('units_done')} of {summary.get('units_total')} units done")
    totals = summary.get("totals") or {}
    rows_in, rows_out = int(totals.get("rows_in", 0) or 0), int(totals.get("rows_out", 0) or 0)
    if rows_out == 0 and (rows_in > 0 or fatal_total > 0):
        # tolerated events that failed before projection never reach rows_in
        problems.append(f"run read {rows_in} records, tolerated {fatal_total} fatal input errors and exported none")
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
    manifest: list[Unit] | None = None,
    envelope: RunEnvelope | None = None,
    manifest_digest: str | None = None,
    inputs: RunInputs,
) -> ValidationReport:
    started = time.monotonic()
    registry = registry or default_registry()
    report = ValidationReport(run_id=run_id, ok=True, report_digest=report_digest(run_report))
    report.checks.append(run_complete_check(run_report, run_id, manifest, envelope, manifest_digest))
    report.envelope_sha256 = envelope_digest(envelope) if envelope is not None else ""
    expected = _expected_rows_by_type(run_report)
    con = duckdb.connect()
    con.execute("set TimeZone = 'UTC'")
    present: dict[str, list[Path]] = {}
    for sample_type, _, _, files in list_compacted(compacted_root):
        present.setdefault(sample_type, []).extend(files)
    report.compacted_digest, report.entries = compacted_fingerprint(compacted_root)
    report.files = len(report.entries)
    report.base_dataset_sha256 = inputs.base_dataset_sha256
    report.checks.extend(_reconciliation_checks(con, compacted_root, run_report, inputs))

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
            report.checks.append(
                Check(
                    name="value_nulls",
                    sample_type=sample_type,
                    ok=value_nulls == 0,
                    detail=f"{value_nulls} null values",
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
        prefixes = _accepted_prefixes(run_report)
        if prefixes:
            cond = " and ".join(
                f"not (starts_with(sample_id, '{p}') and starts_with(source_record_id, '{p}'))" for p in prefixes
            )
            foreign = con.execute(f"select count(*) from read_parquet('{glob}') where {cond}").fetchone()
            n_foreign = int(foreign[0]) if foreign else 0
            report.checks.append(
                Check(
                    name="identity_namespace",
                    sample_type=sample_type,
                    ok=n_foreign == 0,
                    detail=f"{n_foreign} rows outside accepted key epochs {list(prefixes)}",
                )
            )
        conflicts = _unit_total(run_report, sample_type, "dedup_conflicts")
        report.checks.append(
            Check(
                name="dedup_conflicts",
                sample_type=sample_type,
                ok=True,
                detail=f"{conflicts} sample ids with differing copies",
            )
        )
        report.checks.append(_phi_scan(con, glob, spec))

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


def _phi_scan(con: duckdb.DuckDBPyConnection, glob: str, spec: TypeSpec) -> Check:
    """Every distinct value of every free-text column against every pattern. Complete, not sampled: the
    columns are descriptors with few distinct values, so the scan stays cheap at any row count."""
    string_columns = [f.name for f in spec.arrow_schema if f.type == pa.string() and f.name not in ID_COLUMNS]
    if not string_columns:
        return Check(name="phi_scan", sample_type=spec.sample_type, ok=True, detail="no text columns")
    union = " union all ".join(
        f"select '{c}' as col, \"{c}\" as v from (select distinct \"{c}\" from read_parquet('{glob}')) "
        f'where "{c}" is not null'
        for c in string_columns
    )
    exprs = ", ".join("count(*) filter (where regexp_matches(v, ?))" for _ in PHI_PATTERNS)
    rows = con.execute(
        f"select col, count(*), {exprs} from ({union}) group by col order by col", list(PHI_PATTERNS.values())
    ).fetchall()
    hits: dict[str, int] = {}
    distinct_total = 0
    for row in rows:
        distinct_total += int(row[1])
        for label, n in zip(PHI_PATTERNS, row[2:], strict=True):
            if n:
                hits[f"{row[0]}:{label}"] = int(n)
    detail = str(hits) if hits else f"{len(string_columns)} columns clean, {distinct_total} distinct values"
    return Check(name="phi_scan", sample_type=spec.sample_type, ok=not hits, detail=detail)
