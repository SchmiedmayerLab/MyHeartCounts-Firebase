# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Per-unit deduplication on sample_id. Precedence: writer_version desc, converted_at desc, Firestore over archive."""

from __future__ import annotations

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc

TUPLE_KEYS = ["effective_start", "effective_end", "value", "value_code", "source_bundle_hash"]


def _writer_version_rank(table: pa.Table) -> pa.Array:
    col = table["writer_version"]
    numeric = pc.cast(col, pa.int64(), safe=False) if col.null_count < len(col) else pa.nulls(len(col), pa.int64())
    return pc.fill_null(numeric, -1)


def dedup(table: pa.Table) -> tuple[pa.Table, int]:
    """Returns (deduplicated table sorted by effective_start, number of rows removed)."""
    if table.num_rows == 0:
        return table, 0
    ranked = table.append_column("_wv", _writer_version_rank(table))
    ranked = ranked.append_column("_ca", pc.fill_null(pc.cast(table["converted_at"], pa.int64()), -1))
    ranked = ranked.append_column("_fa", pc.cast(table["from_archive"], pa.int8()))
    order = pc.sort_indices(
        ranked,
        sort_keys=[
            ("sample_id", "ascending"),
            ("_wv", "descending"),
            ("_ca", "descending"),
            ("_fa", "ascending"),
            ("export_seq", "ascending"),
        ],
    )
    ranked = ranked.take(order)
    ids = ranked["sample_id"].to_numpy(zero_copy_only=False)
    keep = np.ones(len(ids), dtype=bool)
    keep[1:] = ids[1:] != ids[:-1]
    kept = ranked.filter(pa.array(keep)).drop_columns(["_wv", "_ca", "_fa"])
    removed = table.num_rows - kept.num_rows
    kept = kept.take(pc.sort_indices(kept, sort_keys=[("effective_start", "ascending"), ("sample_id", "ascending")]))
    return kept, removed


def tuple_collisions(table: pa.Table) -> int:
    """Rows that share the content tuple with another row but carry a different sample_id. Reported, never merged."""
    if table.num_rows == 0:
        return 0
    counts = table.select(TUPLE_KEYS).group_by(TUPLE_KEYS).aggregate([([], "count_all")])
    n = counts["count_all"]
    return int(pc.sum(pc.subtract(n, 1)).as_py() or 0)
