<!--
This source file is part of the MyHeart Counts project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->

# MyHeart Counts Export Pipeline v0.0.1 alpha

Scheduled, repeatable export of the collected HealthKit records into pseudonymized, schema-enforced Parquet for research. Version 1 covers HealthKit records only; SensorKit streams, questionnaires and custom sample types belong to separate pipelines. Source data is never modified. Every stage is idempotent, so a run can be paused, killed or redone without loss or duplication.

The data contract for every record is the [Grove FHIR standard](https://github.com/SchmiedmayerLab/grove-fhir): identities, retractions, units and time rules follow it. Until the app emits Grove itself, the pipeline upgrades the current upload shape to Grove in memory. Not ideal, will be changed for the first real deployment. Currently the focus is to shape and test the output.

## How it works

```text
source bucket                       private project
   |  plan: list objects created in [watermark, batch end), group by user x sample type,
   |        drop ineligible users, write manifest.jsonl and the run envelope run.json
   v
work:     decode -> upgrade to Grove -> project to rows -> dedup -> retractions -> staged Parquet parts
          + the unit's retraction ledger part; many workers share a manifest through leases
report:   assemble the run report from the committed unit results
compact:  rebuild each partition the run changes: staged parts + committed lake files,
          deduplicated across runs, minus the cumulative retraction ledger -> files of about 500 MB
validate: contract checks, independent reconciliation of every rebuilt partition, PHI scan
promote:  upload new files, write the next dataset manifest, swap the lake pointer atomically
   |
   v
datalake bucket  v1/{sampleType}/year=YYYY/month=MM/part-{run}-{n}.parquet   immutable files
                 runs/{run}/dataset.jsonl                                     files of each dataset version
                 _current.json                                                the committed version
```

A **unit** is one user and one sample type. Workers read a unit's objects, write deterministic staged parts, and never touch each other's output, so units can be processed on any number of machines.

The source is the bucket only. Firestore is read at plan time for the user documents, never for health records.

### Run envelope and eligibility

`plan` fixes what a run covers in `run.json`, next to the manifest in the private state location: the batch window, whether the window was applied, any participant or type scope, the manifest digest, the eligibility result, and the registry and package versions. Every later phase verifies it: `work` refuses a manifest that changed after planning, `validate` checks that the report, manifest and envelope belong together, and `promote` takes the batch bounds from the envelope instead of a flag.

- **Contiguity.** `plan --lake` starts the window where the lake's committed run ended, and `promote` refuses a run that does not start exactly there. A failed or skipped month is therefore never silently passed over.
- **Scope.** A plan with `--uid` or `--sample-type` is scoped and never promotes. A production lake (a `gs://` destination) additionally requires an applied window, a batch end, and checked eligibility.
- **Eligibility.** Users without an account document, with `toBeDeleted`, or with `hasWithdrawnFromStudy` are excluded at plan time; the envelope records how many users and units were excluded per reason. Rows already published for a participant who withdraws later stay in the lake until participant-level retraction exists.

### Pseudonymization

- `participant_id` is a random UUID per user, kept in a lookup that never leaves the private project. The lookup deliberately retains the link, which is why the output is pseudonymized rather than anonymous.
- `sample_id` and `source_record_id` are Grove opaque identities: HMAC-SHA-256 over the HealthKit UUID and the participant scope with a key in Secret Manager. They are stable, so dedup and retraction work, and nothing in the export leads back to the UUID or the uid.
- Only an allowlist of fields is projected. Device names, source names, bundle identifiers and free-form metadata are dropped. The source bundle is kept only as a keyed hash so per-device analyses stay possible.
- Validation refuses to promote if any exported participant id equals a Firebase uid, if any identifier has the wrong shape or comes from an unknown key epoch, or if any distinct value of a free-text column matches an email, phone, possessive or localized device-name, UUID or HealthKit source bundle pattern. That scan is complete, not sampled: it runs over the distinct values of every descriptor column.
- Staging parts, manifests and raw run reports carry Firebase uids. They live in a private state location; only Parquet, the validation report and a sanitized summary are written to the lake, and `promote` refuses a lake in the same bucket as the state.

### Output contract

One table per sample type with the same common columns, BigQuery-compatible types only. Timestamps are `TIMESTAMP` in UTC at millisecond precision, with the original numeric offset in `utc_offset_min` and the IANA zone in `timezone` when it agrees with that offset. Measured values are always `FLOAT64` in the canonical UCUM unit of the type, percentages in percentage points (HealthKit's fraction-based percent is scaled by 100 on the legacy path); values outside the Grove catalog's domain, non-integral counts and non-finite numbers are dropped and counted, never kept. Category values carry the Grove code and the HealthKit case. Every row carries `upload_kind`, `export_run_id` and `export_seq` for provenance.

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

Per-type facts (measurement id, unit, value domain, effective kind, allowed values) come from the generated registry in [`mhc_export/schemas/`](mhc_export/schemas/README.md), which ships inside the package. The heart rate table adds `motion_context`.

## Running it
This is currently for local testing, I will append more info here once we have a cloud running instance.

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

`run-local` plans without a creation-time window, because local file times are not upload times, then runs `work`, `compact`, `validate` and `promote` into `/out/lake`; `--phases` selects a subset and `--user-flags` applies eligibility from a JSON file of user documents.

Against GCS, one command per phase:

```sh
uv run mhc-export plan --source gs://source-bucket --manifest gs://state/runs/r2026-10/manifest.jsonl --run-id r2026-10 \
    --lake gs://lake --batch-end 2026-10-01T00:00:00Z --project my-project
# on every worker VM, in parallel
uv run mhc-export work --manifest gs://state/runs/r2026-10/manifest.jsonl --state gs://state --run-id r2026-10 \
    --key-secret projects/P/secrets/export-hmac/versions/3 --key-id prod --key-epoch 1 --production \
    --leases firestore --project my-project
# once, after all workers exited
uv run mhc-export report --manifest gs://state/runs/r2026-10/manifest.jsonl --state gs://state --run-id r2026-10 \
    --leases firestore --project my-project
uv run mhc-export compact --state gs://state --lake gs://lake --run-id r2026-10 --work-dir /ssd/work --out /ssd/compacted
uv run mhc-export validate --compacted /ssd/compacted --report gs://state/runs/r2026-10/report.json \
    --manifest gs://state/runs/r2026-10/manifest.jsonl --run-id r2026-10 --out /ssd/validation.json \
    --state gs://state --lake gs://lake --work-dir /ssd/work
uv run mhc-export promote --compacted /ssd/compacted --lake gs://lake --state gs://state --run-id r2026-10 \
    --validation /ssd/validation.json --report gs://state/runs/r2026-10/report.json \
    --envelope gs://state/runs/r2026-10/run.json
uv run mhc-export bq-load --lake gs://lake --project my-project --dataset mhc_export
```

The HMAC key must be at least 32 bytes; the Grove public conformance key is rejected outside tests. `--key-secret` reads it from Secret Manager, and `--production` refuses a local key id, the test key and file-based participant lookups. `--key-id` and `--key-epoch` become part of every identity and are recorded, without the secret, in every run report and lake summary; identities from other epochs are accepted only when listed with `--accept-epoch`. Unreadable or corrupt input, and Grove records whose identity is malformed, duplicated, from an unaccepted key epoch or whose writer version is not a canonical decimal, fail the unit and therefore the run; `--tolerate-fatal N` allows a stated number and records it in the report. A run that read records but exported none never validates.

## Package layout

```text
mhc_export/
  io/          codec (zstd, zlib, plain JSON and CSV), blob stores (local, GCS, routed), prefix sync
  identity/    Grove opaque identities, participant lookup
  grove/       typed view over an Observation in the current or the Grove shape
  transform/   time parsing, UCUM units, category values, type specs, projection, dedup, tombstones, Parquet writer
  sources/     bucket layouts and manifest planning, user eligibility flags
  run/         models, run envelope, manifest, leases and workers, unit processing, run inputs, compaction,
               validation, the lake (dataset manifests and pointer), promotion, inspection, BigQuery loading
  cli.py       new-key, plan, work, report, compact, validate, promote, run-local, inspect, bq-load
scripts/       registry generator (writes mhc_export/schemas/healthkit-types.json)
tests/         unit, golden and end-to-end tests over synthetic fixtures
```

## Guarantees and limits

- A unit's staged parts have deterministic names, so a redo overwrites, never duplicates.
- Compaction rebuilds a partition from this run's staged parts and the partition's committed files, keeps one row per sample id across runs (highest canonical writer version, then latest conversion, then the newer run), and removes every sample id in the cumulative retraction ledger. A re-upload after a reinstall therefore never duplicates a sample, a deletion that arrives in a later run removes the published row, and a deletion that arrives before its sample suppresses it when it shows up. Partitions a run does not touch keep their files.
- Every unit's retractions, matched or not, are kept as a ledger part and committed into the state's ledger before the lake pointer moves, so no retraction is lost to a crash between the two.
- Validation recomputes every rebuilt partition's row count from the run's inputs with an independent query, checks that no retracted sample survives anywhere the run could reach, and binds its verdict to the content hash of every compacted file, the run report, the envelope and the lake version it built on. Promote refuses anything else, verifies every uploaded object against the validated hash, and refuses incomplete, filtered or error-tolerating runs beyond their declared tolerance.
- Publication is one compare-and-swap of `_current.json`. Readers see the previous or the next complete dataset, never a mix; a promoter that lost a race publishes nothing. A run's `runs/{run}/dataset.jsonl` lists exactly the files of that dataset version and is its citation; replaced files stay in the bucket until garbage collection.
- Workers claim units through leases with fencing tokens: a worker that lost its lease cannot complete the unit, expired leases are taken over, and a unit fails for good after `--max-attempts`. `report` refuses to assemble a run whose workers used different configurations.
- BigQuery loads replace month partitions from the committed manifest's file list under deterministic job ids, so a retry never appends twice; partitions a run removed are deleted from the table.
- Records the app cannot represent in Grove, and values outside the catalog domain, are dropped and counted per reason in the run report, never silently. Copies of one sample that disagree in content are counted as conflicts.
- A unit fails as soon as it passes `--max-unit-rows` (default five million), before the rest is buffered. Each unit records its Arrow allocation (`arrow_mb`) and the process high-water mark (`peak_rss_mb`).
- A per-unit sidecar names every part an attempt may write before it writes any, so a redo removes parts from an interrupted or earlier attempt that it no longer produces.

Known limits of this version: the VM orchestration (instance group, scheduler, orchestrator function) is not part of this package; garbage collection of replaced lake files is not automated; a deletion of a sample is found through the participant ranges of the committed files, so retractions for participants with data in many months rebuild those months.

## Development

```sh
uv run ruff check . && uv run ruff format --check .
uv run pytest -q
uv run python scripts/gen_registry.py /path/to/grove-fhir   # refresh mhc_export/schemas/healthkit-types.json
```
