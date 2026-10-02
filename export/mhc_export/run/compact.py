# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Compaction: staged per-unit parts of one (sample type, year, month) -> files of about target_bytes.

DuckDB performs the out-of-core sort; pyarrow writes the files so that size rolling is exact, output names are
deterministic, and every file carries its own covered span in the Parquet key-value metadata.
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

from mhc_export.transform.specs import Registry, TypeSpec, default_registry

log = logging.getLogger(__name__)

DEFAULT_TARGET_BYTES = 500 * 1024 * 1024
ROWS_PER_BATCH = 131_072
MANIFEST_NAME = "_manifest.json"
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


def list_type_months(staging_root: Path) -> list[TypeMonth]:
    out: list[TypeMonth] = []
    if not staging_root.is_dir():
        return out
    for type_dir in sorted(p for p in staging_root.iterdir() if p.is_dir()):
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


def _sorted_batches(
    con: duckdb.DuckDBPyConnection, parts: tuple[Path, ...], schema: pa.Schema, rows_per_batch: int = ROWS_PER_BATCH
) -> Iterator[pa.RecordBatch]:
    columns = ", ".join(f'"{name}"' for name in schema.names)
    paths = "[" + ", ".join(f"'{p}'" for p in parts) + "]"
    rel = con.execute(
        f"select {columns} from read_parquet({paths}, union_by_name = true) "
        "order by participant_id, effective_start, sample_id"
    )
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
        metadata.update(
            row_count=str(self._rows),
            participant_count=str(len(self._participants)),
            covered_start=_iso_us(self._first),
            covered_end=_iso_us(self._last),
        )
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


def compact_type_month(
    tm: TypeMonth,
    out_dir: Path,
    spec: TypeSpec,
    *,
    run_id: str,
    grove_version: str,
    target_bytes: int = DEFAULT_TARGET_BYTES,
    con: duckdb.DuckDBPyConnection | None = None,
    rows_per_batch: int = ROWS_PER_BATCH,
) -> CompactionResult:
    started = time.monotonic()
    con = con or _connect(None, None, None)
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".tmp-{out_dir.name}-", dir=out_dir.parent))
    base = {
        "sample_type": tm.sample_type,
        "measurement_id": spec.measurement_id or "",
        "export_run_id": run_id,
        "grove_version": grove_version,
        "year": f"{tm.year:04d}",
        "month": f"{tm.month:02d}",
    }
    writer = _RollingWriter(tmp, spec.arrow_schema, target_bytes, base)
    rows = 0
    for batch in _sorted_batches(con, tm.parts, spec.arrow_schema, rows_per_batch):
        writer.write(batch)
        rows += batch.num_rows
    files = writer.close()
    manifest = {
        "key": tm.key,
        "sample_type": tm.sample_type,
        "year": tm.year,
        "month": tm.month,
        "run_id": run_id,
        "rows": rows,
        "source_parts": [p.name for p in tm.parts],
        "files": [{"name": f.name, "bytes": f.stat().st_size, "rows": pq.read_metadata(f).num_rows} for f in files],
    }
    (tmp / MANIFEST_NAME).write_text(json.dumps(manifest, indent=1))
    if out_dir.exists():
        shutil.rmtree(out_dir)
    tmp.rename(out_dir)
    result = CompactionResult(
        key=tm.key,
        files=[str(out_dir / f.name) for f in files],
        rows=rows,
        bytes=sum((out_dir / f.name).stat().st_size for f in files),
        seconds=time.monotonic() - started,
    )
    log.info(
        "compacted %s: %d rows -> %d files, %.1f MB, %.1fs",
        tm.key,
        rows,
        len(files),
        result.bytes / 1e6,
        result.seconds,
    )
    return result


def compact_run(
    staging_root: Path,
    compacted_root: Path,
    *,
    run_id: str,
    registry: Registry | None = None,
    target_bytes: int = DEFAULT_TARGET_BYTES,
    memory_limit: str | None = None,
    threads: int | None = None,
    temp_dir: Path | None = None,
    keys: set[str] | None = None,
    rows_per_batch: int = ROWS_PER_BATCH,
) -> list[CompactionResult]:
    registry = registry or default_registry()
    con = _connect(memory_limit, threads, temp_dir)
    results: list[CompactionResult] = []
    for tm in list_type_months(staging_root):
        if keys is not None and tm.key not in keys:
            continue
        spec = registry.get(tm.sample_type)
        if spec is None or not spec.exportable:
            log.warning("skipping %s: not exportable", tm.key)
            continue
        out_dir = compacted_root / tm.sample_type / f"year={tm.year:04d}" / f"month={tm.month:02d}"
        results.append(
            compact_type_month(
                tm,
                out_dir,
                spec,
                run_id=run_id,
                grove_version=registry.grove_version,
                target_bytes=target_bytes,
                con=con,
                rows_per_batch=rows_per_batch,
            )
        )
    return results


def list_compacted(compacted_root: Path) -> list[tuple[str, int, int, list[Path]]]:
    out: list[tuple[str, int, int, list[Path]]] = []
    for tm in list_type_months(compacted_root):
        files = [p for p in tm.parts if PART_RE.match(p.name)]
        if files:
            out.append((tm.sample_type, tm.year, tm.month, files))
    return out
