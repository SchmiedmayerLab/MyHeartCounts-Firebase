<!--
This source file is part of the MyHeart Counts project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->

# MyHeart Counts Export Pipeline

Scheduled, repeatable export of the collected HealthKit data into one-way anonymized, schema-enforced Parquet for research. Source data is never modified. Every stage is idempotent, so a run can be paused, killed or redone without loss or duplication.

The data contract for every record is the [Grove FHIR standard](https://github.com/SchmiedmayerLab/grove-fhir): identities, retractions, units and time rules follow it. Until the app emits Grove itself, the pipeline upgrades the current upload shape to Grove in memory.

## How it works

```text
source bucket + Firestore          private project
   |  plan: list objects, group by user x sample type, write manifest.jsonl
   v
work:   decode -> upgrade to Grove -> project to rows -> dedup -> tombstones -> staged Parquet parts
compact: per (type, year, month): DuckDB sort -> files of about 500 MB with per-file metadata
validate: contract checks, run report reconciliation, PHI scan; failure blocks promotion
promote: copy into v1/ (never overwrite), write-once snapshot, sanitized summary, monotonic watermark
   |
   v
datalake bucket  v1/{sampleType}/year=YYYY/month=MM/part-{run}-{n}.parquet
```

A **unit** is one user and one sample type. Workers read a unit's objects, write deterministic staged parts, and never touch each other's output, so units can be processed on any number of machines.

### Anonymization

- `participant_id` is a random UUID per user, kept in a lookup that never leaves the private project.
- `sample_id` and `source_record_id` are Grove opaque identities: HMAC-SHA-256 over the HealthKit UUID and the participant scope with a key in Secret Manager. They are stable, so dedup and retraction work, and nothing in the export leads back to the UUID or the uid.
- Only an allowlist of fields is projected. Device names, source names, bundle identifiers and free-form metadata are dropped. The source bundle is kept only as a keyed hash so per-device analyses stay possible.
- Validation refuses to promote if any exported participant id equals a Firebase uid, if any identifier has the wrong shape, or if a free-text column matches an email, phone, possessive name, UUID or HealthKit source bundle pattern.

### Output contract

One table per sample type with the same common columns, BigQuery-compatible types only. Timestamps are `TIMESTAMP` in UTC at millisecond precision, with the original numeric offset in `utc_offset_min` and the IANA zone in `timezone` when it agrees with that offset. Measured values are always `FLOAT64` in the canonical UCUM unit of the type. Category values carry the Grove code and the HealthKit case. Every row carries `upload_kind`, `export_run_id` and `export_seq` for provenance.

| Column | Type | Meaning |
|---|---|---|
| `sample_id`, `source_record_id` | STRING | Grove opaque identities |
| `participant_id` | STRING | pseudonymous participant |
| `sample_type`, `measurement_id` | STRING | HealthKit type and Grove measurement |
| `effective_start`, `effective_end` | TIMESTAMP | UTC; end is NULL for instants |
| `utc_offset_min`, `timezone` | INT64, STRING | offset and zone of the sample |
| `value`, `unit` | FLOAT64, STRING | quantity in the canonical unit |
| `value_code`, `value_source_code` | STRING | category value, Grove and HealthKit codes |
| `recording_method` | STRING | `manual-entry` when the user typed it |
| `device_*`, `source_*` | STRING | hardware and writer descriptors, no names |
| `writer_record_id`, `writer_version` | STRING | Grove writer identity for third-party revisions |
| `study_revision`, `app_version`, `app_build` | INT64, STRING | study context |
| `converted_at` | TIMESTAMP | when the app converted the sample |
| `upload_kind`, `from_archive` | STRING, BOOL | historical or live, bucket or Firestore |
| `export_run_id`, `export_seq` | STRING, INT64 | provenance |

Per-type facts (measurement id, unit, effective kind, allowed values) come from the generated registry in [`schemas/`](schemas/README.md). The heart rate table adds `motion_context`.

## Running it

```sh
cd export
uv sync --extra dev
uv run pytest
uv run mhc-export --help
```

Local end to end over a directory laid out like the bucket (`users/{uid}/...`):

```sh
uv run mhc-export new-key > key.hex
uv run mhc-export run-local --source /data --out /out --run-id r2026-10 --key-file key.hex --key-id dev \
    --batch-end 2026-10-01T00:00:00Z
uv run mhc-export inspect /out/staging/r2026-10 --show HKQuantityTypeIdentifierHeartRate
```

`run-local` runs `work`, `compact`, `validate` and `promote` into `/out/lake`; `--phases` selects a subset.

Against GCS, one command per phase:

```sh
uv run mhc-export plan --source gs://source-bucket/users --manifest gs://state/runs/r2026-10/manifest.jsonl
uv run mhc-export work --manifest gs://state/runs/r2026-10/manifest.jsonl --staging gs://lake --run-id r2026-10 --key-file key.hex
uv run mhc-export compact --staging gs://lake/staging/r2026-10 --work-dir /ssd --out /ssd/compacted --run-id r2026-10
uv run mhc-export validate --compacted /ssd/compacted --report gs://lake/runs/r2026-10/report.json \
    --manifest gs://state/runs/r2026-10/manifest.jsonl --run-id r2026-10 --out /ssd/validation.json
uv run mhc-export promote --compacted /ssd/compacted --lake gs://lake --run-id r2026-10 \
    --validation /ssd/validation.json --report gs://lake/runs/r2026-10/report.json --batch-end 2026-10-01T00:00:00Z
uv run mhc-export bq-load gs://lake/v1 --project my-project --dataset mhc_export
```

The HMAC key must be at least 32 bytes; the Grove public conformance key is rejected outside tests. In production it is read from Secret Manager; `--key-id` and `--key-epoch` become part of every identity, so they must never change without a documented key rotation.

## Package layout

```text
mhc_export/
  io/          codec (zstd, zlib, plain JSON and CSV), blob stores (local, GCS, routed), prefix sync
  identity/    Grove opaque identities, participant lookup
  grove/       typed view over an Observation in the current or the Grove shape
  transform/   time parsing, UCUM units, category values, type specs, projection, dedup, tombstones, Parquet writer
  sources/     bucket layouts and manifest planning, Firestore observations
  run/         models, manifest, unit processing, compaction, validation, promotion, inspection, BigQuery loading
  cli.py       new-key, plan, work, compact, validate, promote, run-local, inspect, bq-load
schemas/       generated HealthKit type registry
scripts/       registry generator
tests/         unit, golden and end-to-end tests over synthetic fixtures
```

## Guarantees and limits

- A unit's staged parts have deterministic names, so a redo overwrites, never duplicates.
- Compaction writes into a temporary directory and replaces the type-month directory wholesale.
- Validation binds its verdict to a digest of the compacted files and of the run report; promote refuses anything else, refuses incomplete or filtered runs, and refuses to reuse a run id for a different file set.
- The snapshot listing written at promote time is the citation for a dataset version and is never rewritten.
- The watermark only moves forward.
- Records the app cannot represent in Grove are dropped and counted per reason in the run report, never silently.

Known limits of this version: `v1/` is append-only across runs, so a sample uploaded again in a later batch, for instance after a reinstall, is exported again; partition-replacing promotion is the planned fix. Leases, the run state machine and the VM orchestration are not part of this package yet; `work` is a single worker.

## Development

```sh
uv run ruff check . && uv run ruff format --check .
uv run pytest -q
uv run python scripts/gen_registry.py /path/to/grove-fhir   # refresh schemas/healthkit-types.json
```

Tests never touch real data. Fixtures are synthetic resources in the shape the app uploads.
