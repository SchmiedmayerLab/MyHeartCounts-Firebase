# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Compaction: rebuild every partition (sample type, year, month) a run changes, as files of about target_bytes.

A partition's new content is this run's staged parts plus the partition's committed lake files, deduplicated on
sample_id across runs, minus every sample id in the cumulative retraction ledger. Partitions the run does not touch
keep their committed files. DuckDB performs the out-of-core work; pyarrow writes the files so that size rolling is
exact, output names are deterministic, and every file carries its covered span and participant range in the Parquet
key-value metadata.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from mhc_export.run.inputs import RunInputs, staged_partitions
from mhc_export.transform.specs import Registry, TypeSpec, default_registry

log = logging.getLogger(__name__)

DEFAULT_TARGET_BYTES = 500 * 1024 * 1024
ROWS_PER_BATCH = 131_072
MANIFEST_NAME = "_manifest.json"
TOUCHED_NAME = "_touched.json"
PART_RE = re.compile(r"^part-(\d{5})\.parquet$")


@dataclass(frozen=True)
class TypeMonth:
    sample_type: str
    year: int
    month: int
    parts: tuple[Path, ...]

    @property
    def key(self) -> str:
        return f"{self.sample_type}/year={self.year:04d}/month={self.month:02d}"


@dataclass
class CompactionResult:
    key: str
    files: list[str] = field(default_factory=list)
    rows: int = 0
    bytes: int = 0
    seconds: float = 0.0
    staged_rows: int = 0
    committed_rows: int = 0
    retracted: int = 0
    duplicates: int = 0
    conflicts: int = 0


def partition_key(sample_type: str, year: int, month: int) -> str:
    return f"{sample_type}/year={year:04d}/month={month:02d}"


def list_type_months(staging_root: Path) -> list[TypeMonth]:
    out: list[TypeMonth] = []
    if not staging_root.is_dir():
        return out
    for type_dir in sorted(p for p in staging_root.iterdir() if p.is_dir() and not p.name.startswith("_")):
        for year_dir in sorted(p for p in type_dir.iterdir() if p.is_dir() and p.name.startswith("year=")):
            for month_dir in sorted(p for p in year_dir.iterdir() if p.is_dir() and p.name.startswith("month=")):
                parts = tuple(sorted(p for p in month_dir.glob("*.parquet")))
                if parts:
                    out.append(TypeMonth(type_dir.name, int(year_dir.name[5:]), int(month_dir.name[6:]), parts))
    return out


def _connect(memory_limit: str | None, threads: int | None, temp_dir: Path | None) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    if memory_limit:
        con.execute(f"set memory_limit = '{memory_limit}'")
    if threads:
        con.execute(f"set threads = {int(threads)}")
    if temp_dir:
        temp_dir.mkdir(parents=True, exist_ok=True)
        con.execute(f"set temp_directory = '{temp_dir}'")
    con.execute("set preserve_insertion_order = true")
    return con


def _paths(files: list[Path] | tuple[Path, ...]) -> str:
    return "[" + ", ".join(f"'{p}'" for p in files) + "]"


def _partition_sql(
    columns: list[str], staged: list[Path], committed: list[Path], ledger: list[Path]
) -> tuple[str, str]:
    """(CTE text defining inputs, live and ranked rows, the final select). Ranking keeps one row per sample_id:
    highest canonical writer version, then latest conversion, then this run's copy over a committed one."""
    cols = ", ".join(f'"{c}"' for c in columns)
    branches = []
    if staged:
        branches.append(f"select {cols}, 1 as _fresh from read_parquet({_paths(staged)}, union_by_name = true)")
    if committed:
        branches.append(f"select {cols}, 0 as _fresh from read_parquet({_paths(committed)}, union_by_name = true)")
    retracted = (
        f"(select distinct sample_id from read_parquet({_paths(ledger)}, union_by_name = true))"
        if ledger
        else "(select null::varchar as sample_id where false)"
    )
    ctes = f"""
        with inputs as ({" union all ".join(branches)}),
        retracted as {retracted},
        live as (select * from inputs where sample_id not in (select sample_id from retracted)),
        ranked as (
            select *, row_number() over (
                partition by sample_id
                order by length(coalesce(writer_version, '')) desc, coalesce(writer_version, '') desc,
                         converted_at desc nulls last, _fresh desc, export_run_id desc, export_seq
            ) as _rn
            from live
        )
    """
    final = f"{ctes} select {cols} from ranked where _rn = 1 order by participant_id, effective_start, sample_id"
    return ctes, final


def _partition_counts(con: duckdb.DuckDBPyConnection, ctes: str) -> dict[str, int]:
    row = con.execute(
        f"""{ctes}
        select
            (select count(*) from inputs where _fresh = 1),
            (select count(*) from inputs where _fresh = 0),
            (select count(*) from inputs) - (select count(*) from live),
            (select count(*) from live) - (select count(distinct sample_id) from live),
            (select count(*) from (
                select sample_id from (
                    select distinct sample_id, effective_start, effective_end, value, unit, value_code from live
                ) group by sample_id having count(*) > 1
            ))
        """
    ).fetchone()
    assert row is not None
    return dict(
        zip(("staged_rows", "committed_rows", "retracted", "duplicates", "conflicts"), map(int, row), strict=True)
    )


def _sorted_batches(
    con: duckdb.DuckDBPyConnection, query: str, schema: pa.Schema, rows_per_batch: int = ROWS_PER_BATCH
) -> Iterator[pa.RecordBatch]:
    rel = con.execute(query)
    reader = (
        rel.to_arrow_reader(rows_per_batch)
        if hasattr(rel, "to_arrow_reader")
        else rel.fetch_record_batch(rows_per_batch)
    )
    for batch in reader:
        table = pa.Table.from_batches([batch]).cast(schema).combine_chunks()
        for offset in range(0, table.num_rows, rows_per_batch):
            yield table.slice(offset, rows_per_batch).to_batches()[0]


class _RollingWriter:
    """Writes sorted batches into part-NNNNN.parquet files, rolling when the bytes written pass the target."""

    def __init__(self, out_dir: Path, schema: pa.Schema, target_bytes: int, base_metadata: dict[str, str]) -> None:
        self.out_dir = out_dir
        self.schema = schema
        self.target_bytes = target_bytes
        self.base_metadata = base_metadata
        self.files: list[Path] = []
        self._writer: pq.ParquetWriter | None = None
        self._sink: pa.OSFile | None = None
        self._path: Path | None = None
        self._rows = 0
        self._first: int | None = None
        self._last: int | None = None
        self._participants: set[str] = set()
        self.ranges: dict[str, tuple[str | None, str | None]] = {}

    def _open(self) -> None:
        self._path = self.out_dir / f"part-{len(self.files):05d}.parquet"
        self._sink = pa.OSFile(str(self._path), "wb")
        self._writer = pq.ParquetWriter(
            self._sink, self.schema, compression="zstd", version="2.6", write_statistics=True
        )
        self._rows = 0
        self._first = self._last = None
        self._participants = set()

    def write(self, batch: pa.RecordBatch) -> None:
        if self._writer is None:
            self._open()
        assert self._writer is not None and self._sink is not None
        self._writer.write_batch(batch)
        self._rows += batch.num_rows
        start = batch.column("effective_start")
        end = pc.fill_null(batch.column("effective_end"), start)
        lo = pc.min(start).cast(pa.int64()).as_py()
        hi = pc.max(end).cast(pa.int64()).as_py()
        self._first = lo if self._first is None else min(self._first, lo)
        self._last = hi if self._last is None else max(self._last, hi)
        self._participants.update(pc.unique(batch.column("participant_id")).to_pylist())
        if self._sink.tell() >= self.target_bytes:
            self.close_current()

    def close_current(self) -> None:
        if self._writer is None:
            return
        assert self._path is not None and self._sink is not None
        metadata = dict(self.base_metadata)
        lo = min(self._participants) if self._participants else None
        hi = max(self._participants) if self._participants else None
        metadata.update(
            row_count=str(self._rows),
            participant_count=str(len(self._participants)),
            participant_min=lo or "",
            participant_max=hi or "",
            covered_start=_iso_us(self._first),
            covered_end=_iso_us(self._last),
        )
        self.ranges[self._path.name] = (lo, hi)
        self._writer.add_key_value_metadata(metadata)
        self._writer.close()
        self._sink.close()
        self._writer = None
        self._sink = None
        self.files.append(self._path)
        self._path = None

    def close(self) -> list[Path]:
        self.close_current()
        return self.files


def _iso_us(epoch_us: int | None) -> str:
    if epoch_us is None:
        return ""
    return (
        datetime.fromtimestamp(epoch_us / 1_000_000, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


class SchemaDrift(ValueError):
    pass


def check_input_schemas(spec: TypeSpec, files: list[Path]) -> None:
    """Inputs must carry exactly the type's columns; merging by name would fill a missing column with NULL."""
    expected = [(f.name, f.type) for f in spec.arrow_schema]
    for path in files:
        found = [(f.name, f.type) for f in pq.read_schema(path)]
        if found != expected:
            missing = sorted({n for n, _ in expected} - {n for n, _ in found})
            extra = sorted({n for n, _ in found} - {n for n, _ in expected})
            raise SchemaDrift(
                f"{path} does not match the {spec.sample_type} schema (missing {missing}, extra {extra}, or types "
                "differ); rework the run with this package version, or rebuild the lake after a contract change"
            )


def compact_partition(
    partition: tuple[str, int, int],
    out_dir: Path,
    spec: TypeSpec,
    *,
    staged: list[Path],
    committed: list[Path],
    ledger: list[Path],
    run_id: str,
    grove_version: str,
    target_bytes: int = DEFAULT_TARGET_BYTES,
    con: duckdb.DuckDBPyConnection | None = None,
    rows_per_batch: int = ROWS_PER_BATCH,
) -> CompactionResult:
    started = time.monotonic()
    sample_type, year, month = partition
    key = partition_key(sample_type, year, month)
    check_input_schemas(spec, [*staged, *committed])
    con = con or _connect(None, None, None)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".tmp-{out_dir.name}-", dir=out_dir.parent))
    base = {
        "sample_type": sample_type,
        "measurement_id": spec.measurement_id or "",
        "export_run_id": run_id,
        "grove_version": grove_version,
        "year": f"{year:04d}",
        "month": f"{month:02d}",
    }
    writer = _RollingWriter(tmp, spec.arrow_schema, target_bytes, base)
    rows = 0
    counts = {"staged_rows": 0, "committed_rows": 0, "retracted": 0, "duplicates": 0, "conflicts": 0}
    if staged or committed:
        ctes, final = _partition_sql(spec.arrow_schema.names, staged, committed, ledger)
        counts = _partition_counts(con, ctes)
        for batch in _sorted_batches(con, final, spec.arrow_schema, rows_per_batch):
            writer.write(batch)
            rows += batch.num_rows
    files = writer.close()
    manifest = {
        "key": key,
        "sample_type": sample_type,
        "year": year,
        "month": month,
        "run_id": run_id,
        "rows": rows,
        **counts,
        "staged_parts": [p.name for p in staged],
        "committed_files": [p.name for p in committed],
        "files": [
            {
                "name": f.name,
                "bytes": f.stat().st_size,
                "rows": pq.read_metadata(f).num_rows,
                "participant_min": writer.ranges[f.name][0],
                "participant_max": writer.ranges[f.name][1],
            }
            for f in files
        ],
    }
    (tmp / MANIFEST_NAME).write_text(json.dumps(manifest, indent=1))
    if out_dir.exists():
        shutil.rmtree(out_dir)
    tmp.rename(out_dir)
    result = CompactionResult(
        key=key,
        files=[str(out_dir / f.name) for f in files],
        rows=rows,
        bytes=sum((out_dir / f.name).stat().st_size for f in files),
        seconds=time.monotonic() - started,
        **counts,
    )
    log.info(
        "compacted %s: %d staged + %d committed - %d retracted - %d duplicates -> %d rows in %d files, %.1fs",
        key,
        counts["staged_rows"],
        counts["committed_rows"],
        counts["retracted"],
        counts["duplicates"],
        rows,
        len(files),
        result.seconds,
    )
    return result


def touched_partitions(con: duckdb.DuckDBPyConnection, inputs: RunInputs) -> set[tuple[str, int, int]]:
    """Staged partitions, plus committed partitions that contain a sample id retracted by this run."""
    touched = set(staged_partitions(inputs.staging_root))
    for (sample_type, year, month), files in inputs.committed.items():
        fresh = inputs.fresh_ledger.get(sample_type)
        if (sample_type, year, month) in touched or not fresh or not files:
            continue
        hit = con.execute(
            f"select count(*) from read_parquet({_paths(files)}) "
            f"where sample_id in (select sample_id from read_parquet({_paths(fresh)}))"
        ).fetchone()
        if hit and hit[0]:
            touched.add((sample_type, year, month))
    return touched


def compact_run(
    inputs: RunInputs,
    compacted_root: Path,
    *,
    run_id: str,
    registry: Registry | None = None,
    target_bytes: int = DEFAULT_TARGET_BYTES,
    memory_limit: str | None = None,
    threads: int | None = None,
    temp_dir: Path | None = None,
    rows_per_batch: int = ROWS_PER_BATCH,
) -> list[CompactionResult]:
    registry = registry or default_registry()
    con = _connect(memory_limit, threads, temp_dir)
    if compacted_root.exists():
        shutil.rmtree(compacted_root)
    compacted_root.mkdir(parents=True)
    staged_by_partition: dict[tuple[str, int, int], list[Path]] = {}
    for tm in list_type_months(inputs.staging_root):
        staged_by_partition[(tm.sample_type, tm.year, tm.month)] = list(tm.parts)
    results: list[CompactionResult] = []
    touched_keys: list[str] = []
    for partition in sorted(touched_partitions(con, inputs)):
        sample_type, year, month = partition
        spec = registry.get(sample_type)
        if spec is None or not spec.exportable:
            log.warning("skipping %s: not exportable", partition_key(*partition))
            continue
        out_dir = compacted_root / sample_type / f"year={year:04d}" / f"month={month:02d}"
        results.append(
            compact_partition(
                partition,
                out_dir,
                spec,
                staged=staged_by_partition.get(partition, []),
                committed=inputs.committed.get(partition, []),
                ledger=inputs.ledger.get(sample_type, []),
                run_id=run_id,
                grove_version=registry.grove_version,
                target_bytes=target_bytes,
                con=con,
                rows_per_batch=rows_per_batch,
            )
        )
        touched_keys.append(partition_key(*partition))
    (compacted_root / TOUCHED_NAME).write_text(
        json.dumps(
            {
                "run_id": run_id,
                "base_dataset_sha256": inputs.base_dataset_sha256,
                "partitions": touched_keys,
                "counts": {
                    r.key: {
                        k: getattr(r, k)
                        for k in ("rows", "staged_rows", "committed_rows", "retracted", "duplicates", "conflicts")
                    }
                    for r in results
                },
            },
            indent=1,
        )
    )
    return results


def read_touched(compacted_root: Path) -> dict:
    path = compacted_root / TOUCHED_NAME
    if not path.is_file():
        raise FileNotFoundError(f"{path} is missing; compact the run first")
    return json.loads(path.read_text())


def list_compacted(compacted_root: Path) -> list[tuple[str, int, int, list[Path]]]:
    out: list[tuple[str, int, int, list[Path]]] = []
    for tm in list_type_months(compacted_root):
        files = [p for p in tm.parts if PART_RE.match(p.name)]
        if files:
            out.append((tm.sample_type, tm.year, tm.month, files))
    return out
