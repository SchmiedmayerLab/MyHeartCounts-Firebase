# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Load staged or promoted Parquet into BigQuery.

One table per sample type, partitioned by month of effective_start, clustered by participant_id.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator
from pathlib import Path

log = logging.getLogger(__name__)

TABLE_RE = re.compile(r"[^A-Za-z0-9_]")


def table_name(sample_type: str) -> str:
    return TABLE_RE.sub("_", sample_type).lower()


def _types_under(prefix: Path) -> Iterator[tuple[str, list[Path]]]:
    for type_dir in sorted(p for p in prefix.iterdir() if p.is_dir()):
        files = sorted(type_dir.rglob("*.parquet"))
        if files:
            yield type_dir.name, files


def load_local_prefix(prefix: Path, project: str, dataset: str, *, replace: bool = True) -> dict[str, int]:
    """Uploads local Parquet files. Returns rows per table."""
    from google.cloud import bigquery

    client = bigquery.Client(project=project)
    loaded: dict[str, int] = {}
    for sample_type, files in _types_under(prefix):
        table_id = f"{project}.{dataset}.{table_name(sample_type)}"
        config = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE
            if replace
            else bigquery.WriteDisposition.WRITE_APPEND,
            time_partitioning=bigquery.TimePartitioning(
                type_=bigquery.TimePartitioningType.MONTH, field="effective_start"
            ),
            clustering_fields=["participant_id"],
        )
        for i, path in enumerate(files):
            if i == 1 and replace:
                config.write_disposition = bigquery.WriteDisposition.WRITE_APPEND
            with path.open("rb") as fh:
                job = client.load_table_from_file(fh, table_id, job_config=config)
            job.result()
        table = client.get_table(table_id)
        loaded[table_id] = int(table.num_rows or 0)
        log.info("loaded %s: %d rows from %d files", table_id, loaded[table_id], len(files))
    return loaded


def load_gcs_prefix(gcs_prefix: str, project: str, dataset: str, *, replace: bool = True) -> dict[str, int]:
    """One load job per sample type over gs://.../{sample_type}/year=*/month=*/*.parquet."""
    from google.cloud import bigquery, storage

    bucket_name, _, path = gcs_prefix.removeprefix("gs://").partition("/")
    client = bigquery.Client(project=project)
    types: set[str] = set()
    for blob in storage.Client(project=project).list_blobs(bucket_name, prefix=path.rstrip("/") + "/"):
        rest = blob.name[len(path.rstrip("/")) + 1 :]
        if rest.endswith(".parquet") and "/" in rest:
            types.add(rest.split("/", 1)[0])
    loaded: dict[str, int] = {}
    for sample_type in sorted(types):
        table_id = f"{project}.{dataset}.{table_name(sample_type)}"
        uri = f"gs://{bucket_name}/{path.rstrip('/')}/{sample_type}/year=*/month=*/*.parquet"
        config = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE
            if replace
            else bigquery.WriteDisposition.WRITE_APPEND,
            time_partitioning=bigquery.TimePartitioning(
                type_=bigquery.TimePartitioningType.MONTH, field="effective_start"
            ),
            clustering_fields=["participant_id"],
        )
        client.load_table_from_uri(uri, table_id, job_config=config).result()
        loaded[table_id] = int(client.get_table(table_id).num_rows or 0)
        log.info("loaded %s: %d rows", table_id, loaded[table_id])
    return loaded
