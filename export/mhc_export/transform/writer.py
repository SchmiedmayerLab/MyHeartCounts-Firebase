# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Rows -> Arrow table -> Parquet bytes, split by UTC month of effective_start."""

from __future__ import annotations

import io
import json
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from mhc_export.transform.specs import TIMESTAMP, TIMESTAMP_MS

PARQUET_VERSION = "2.6"


def _ingest_schema(schema: pa.Schema) -> pa.Schema:
    """Rows carry epoch milliseconds for timestamps; build with ms then cast to the contract."""
    return pa.schema(
        [pa.field(f.name, TIMESTAMP_MS if f.type == TIMESTAMP else f.type, nullable=f.nullable) for f in schema],
        metadata=schema.metadata,
    )


def rows_to_table(rows: list[dict[str, Any]], schema: pa.Schema) -> pa.Table:
    if not rows:
        return schema.empty_table()
    return pa.Table.from_pylist(rows, schema=_ingest_schema(schema)).cast(schema)


class RowBuffer:
    """Collects row dicts and converts them to Arrow in chunks so Python object memory stays bounded."""

    def __init__(self, schema: pa.Schema, chunk_size: int = 100_000) -> None:
        self.schema = schema
        self.chunk_size = chunk_size
        self._rows: list[dict[str, Any]] = []
        self._chunks: list[pa.Table] = []
        self.count = 0

    def append(self, row: dict[str, Any]) -> None:
        self._rows.append(row)
        self.count += 1
        if len(self._rows) >= self.chunk_size:
            self._flush()

    def _flush(self) -> None:
        if self._rows:
            self._chunks.append(pa.Table.from_pylist(self._rows, schema=_ingest_schema(self.schema)).cast(self.schema))
            self._rows = []

    def to_table(self) -> pa.Table:
        self._flush()
        if not self._chunks:
            return self.schema.empty_table()
        table = pa.concat_tables(self._chunks).combine_chunks()
        self._chunks = []
        return table


def split_by_month(table: pa.Table) -> Iterator[tuple[int, int, pa.Table]]:
    if table.num_rows == 0:
        return
    start = table["effective_start"]
    years = pc.year(start)
    months = pc.month(start)
    key = pc.add(pc.multiply(pc.cast(years, pa.int64()), 100), pc.cast(months, pa.int64()))
    for k in sorted(pc.unique(key).to_pylist()):
        mask = pc.equal(key, k)
        yield k // 100, k % 100, table.filter(mask)


def to_parquet_bytes(table: pa.Table, *, extra_metadata: dict[str, str] | None = None) -> bytes:
    metadata = dict(table.schema.metadata or {})
    if table.num_rows:
        start = table["effective_start"]
        first = pc.min(start).as_py()
        last = pc.max(pc.fill_null(table["effective_end"], start)).as_py()
        metadata[b"covered_start"] = _iso(first).encode()
        metadata[b"covered_end"] = _iso(last).encode()
        metadata[b"participant_count"] = str(len(pc.unique(table["participant_id"]))).encode()
    metadata[b"row_count"] = str(table.num_rows).encode()
    for k, v in (extra_metadata or {}).items():
        metadata[k.encode()] = v.encode()
    table = table.replace_schema_metadata(metadata)
    buf = io.BytesIO()
    pq.write_table(table, buf, compression="zstd", version=PARQUET_VERSION, write_statistics=True)
    return buf.getvalue()


def read_parquet_metadata(data: bytes | str) -> dict[str, str]:
    """File-level key-value metadata, including keys added at close time."""
    source = io.BytesIO(data) if isinstance(data, bytes) else data
    md = pq.read_metadata(source).metadata or {}
    return {k.decode(): v.decode() for k, v in md.items() if k != b"ARROW:schema"}


def staging_uri(prefix: str, sample_type: str, year: int, month: int, unit_id: str) -> str:
    safe_unit = unit_id.replace(":", "__")
    return f"{prefix.rstrip('/')}/{sample_type}/year={year:04d}/month={month:02d}/{safe_unit}.parquet"


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return json.dumps(value)
