# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""DuckDB summaries over staged or promoted Parquet; the same queries double as validation inputs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import duckdb


@dataclass(frozen=True)
class TypeSummary:
    sample_type: str
    files: int
    bytes: int
    rows: int
    participants: int
    first: str | None
    last: str | None
    null_value: int
    null_offset: int
    null_timezone: int
    distinct_units: list[str]
    distinct_codes: list[str]


def _glob(prefix: Path, sample_type: str) -> str:
    return str(prefix / sample_type / "year=*" / "month=*" / "*.parquet")


def summarize(prefix: Path) -> list[TypeSummary]:
    out: list[TypeSummary] = []
    con = duckdb.connect()
    for type_dir in sorted(p for p in prefix.iterdir() if p.is_dir()):
        files = sorted(type_dir.rglob("*.parquet"))
        if not files:
            continue
        glob = _glob(prefix, type_dir.name)
        row = con.execute(
            f"""
            select count(*), count(distinct participant_id),
                   strftime(min(effective_start), '%Y-%m-%dT%H:%M:%SZ'),
                   strftime(max(effective_start), '%Y-%m-%dT%H:%M:%SZ'),
                   count(*) filter (where value is null), count(*) filter (where utc_offset_min is null),
                   count(*) filter (where timezone is null),
                   list(distinct unit order by unit), list(distinct value_code order by value_code)
            from read_parquet('{glob}', hive_partitioning = true)
            """
        ).fetchone()
        assert row is not None
        out.append(
            TypeSummary(
                sample_type=type_dir.name,
                files=len(files),
                bytes=sum(f.stat().st_size for f in files),
                rows=row[0],
                participants=row[1],
                first=row[2],
                last=row[3],
                null_value=row[4],
                null_offset=row[5],
                null_timezone=row[6],
                distinct_units=[u for u in (row[7] or []) if u is not None],
                distinct_codes=[c for c in (row[8] or []) if c is not None],
            )
        )
    return out


def format_summary(summaries: list[TypeSummary]) -> str:
    header = (
        f"{'sample_type':58s} {'files':>5s} {'MB':>7s} {'rows':>9s} {'ppl':>4s} {'first':20s} {'last':20s} "
        "null_v null_off null_tz units/codes"
    )
    lines = [header]
    for s in summaries:
        codes = "/" + ",".join(s.distinct_codes) if s.distinct_codes else ""
        lines.append(
            f"{s.sample_type:58s} {s.files:5d} {s.bytes / 1e6:7.1f} {s.rows:9d} {s.participants:4d} "
            f"{s.first or '':20s} {s.last or '':20s} {s.null_value:6d} {s.null_offset:8d} {s.null_timezone:7d} "
            f"{','.join(s.distinct_units)}{codes}"
        )
    return "\n".join(lines)


def sample_rows(prefix: Path, sample_type: str, limit: int = 5) -> str:
    con = duckdb.connect()
    rel = con.execute(
        "select * exclude (sample_id, source_record_id, participant_id) "
        f"from read_parquet('{_glob(prefix, sample_type)}', hive_partitioning = true) "
        f"order by effective_start desc limit {int(limit)}"
    )
    return _tabulate(rel)


def _tabulate(rel: duckdb.DuckDBPyConnection) -> str:
    cols = [d[0] for d in rel.description]
    rows = rel.fetchall()
    lines = []
    for row in rows:
        lines.append("  " + "  ".join(f"{c}={v!r}" for c, v in zip(cols, row, strict=True) if v is not None))
    return "\n".join(lines)
