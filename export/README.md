<!--
This source file is part of the MyHeart Counts project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->

# MyHeart Counts Export Pipeline v0.0.1 alpha

Scheduled, repeatable export of the collected HealthKit records into pseudonymized, schema-enforced Parquet for research. Version 1 covers HealthKit records only; SensorKit streams, questionnaires and custom sample types belong to separate pipelines. Source data is never modified. Every stage is idempotent, so a run can be paused, killed or redone without loss or duplication.

The data contract for every record is the [Grove FHIR standard](https://github.com/SchmiedmayerLab/grove-fhir): identities, retractions, units and time rules follow it. The pipeline reads the Grove exchange events the app writes after the Grove migration. The current upload shape is read only with `--accept-legacy`, which upgrades it in memory so the output can be shaped and tested on dev data before the migration.

## How it works

```text
source bucket                       private project
   |  plan: list objects created in [watermark, batch end), group by user x sample type,
   |        drop ineligible users, write manifest.jsonl and the run envelope run.json
   v
work:     decode -> check exchange events -> project to rows -> dedup -> retractions -> staged Parquet parts
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

A **unit** is one user and one sample type. Workers read a unit's objects, write deterministic staged parts, and never touch each other's output, so units can be processed on any number of machines. A unit with more than `--max-unit-bytes` of compressed input (400 MB by default, about 3 million rows and 5 GB of worker memory) is split at plan time into shards of whole objects. Shards need no coordination, because compaction deduplicates and applies the run's whole retraction ledger across all staged parts.

The source is the bucket only. Firestore is read at plan time for the user documents, never for health records.

### Grove input

Each object is a JSON array of Grove exchange Bundles. Every Bundle must pass two checks, and any failure fails the unit with a stable reason:

- **Exchange protocol.** Profiles, the event identity, entry keys and full URLs, references, the single lifecycle Provenance, and opaque identities under an accepted producer namespace, as pinned in grove-fhir.
- **HealthKit adapter.** The HealthKit conversion profile, a source type equal to the unit's type, the type's clinical code, the participant of the object, and exactly one disclosed HealthKit record id per Observation.

The app mints its Grove identities with its own key (namespace `store:1`; `--producer-namespace KEY_ID:EPOCH` replaces the list). The export checks those identities but does not publish them. `sample_id` and `source_record_id` are minted with the export key from the disclosed HealthKit record id, so a sample keeps one id across devices, reinstalls and the migration of legacy uploads. `writer_record_id` is the app's writer identity, passed through.

Retraction events name the retracted Observation and disclose its HealthKit record id; the export maps it to its own sample id and adds it to the ledger. Deletion objects may hold retraction events or the legacy CSV lists, never an active event. The run report counts Grove retractions separately as `grove_retractions`.

Category values are read from the measurement's result code system, which the registry records per type; an event without exactly one coding in that system fails. The descriptor columns come from fixed places in the event. Device columns come from the recording Device, and the source bundle hash and version from the source app's author Device. App version and build come from the assembler Device, and the study revision from the version of the study's PlanDefinition. `converted_at` is the conversion Provenance's recorded instant.

`--accept-legacy` also reads pre-Grove resources and is refused with `--production`. A Grove-shaped resource outside an exchange Bundle is never accepted. The Grove settings of a run are recorded in its report and lake summary.

### Run envelope and eligibility

`plan` fixes what a run covers in `run.json`, next to the manifest in the private state location: the batch window, whether the window was applied, any participant or type scope, the manifest digest, the eligibility result, and the registry and package versions. Every later phase verifies it: `work` refuses a manifest that changed after planning, `validate` checks that the report, manifest and envelope belong together, and `promote` takes the batch bounds from the envelope instead of a flag.

- **Contiguity.** `plan --lake` starts the window where the lake's committed run ended, and `promote` refuses a run that does not start exactly there. A failed or skipped month is therefore never silently passed over. `plan` refuses a batch end in the future, because uploads created after the listing would fall behind the watermark.
- **Scope.** A plan with `--uid` or `--sample-type` is scoped and never promotes. A `gs://` lake additionally requires an applied window, a batch end, checked eligibility, and the same source as its committed run.
- **Production.** `promote --production` also checks what the run recorded rather than the flags of one command. It requires a Secret Manager key, the Firestore participant lookup and eligibility, no legacy input, a whole source bucket and at least one unit.
- **Versions.** The envelope records the package version and digests of the registry and coverage files, and `work` refuses to run with different ones. Workers sharing a run must also agree on a non-secret check value of the key.
- **Eligibility.** Users without an account document, with `toBeDeleted`, or with `hasWithdrawnFromStudy` are excluded at plan time; the envelope records how many users and units were excluded per reason. A plan in which no listed user has an account document fails, since that points to the wrong project or missing permissions. Rows already published for a participant who withdraws later stay in the lake until participant-level retraction exists.

### Pseudonymization

- `participant_id` is a random UUID per user, kept in a lookup that never leaves the private project. The lookup deliberately retains the link, which is why the output is pseudonymized rather than anonymous.
- `sample_id` and `source_record_id` are Grove opaque identities: HMAC-SHA-256 over the HealthKit UUID and the participant scope with a key in Secret Manager. They are stable, so dedup and retraction work, and nothing in the export leads back to the UUID or the uid.
- Only an allowlist of fields is projected. Device names, source names, bundle identifiers and free-form metadata are dropped. The source bundle is kept only as a keyed hash so per-device analyses stay possible.
- Validation refuses to promote if any exported participant id equals a Firebase uid, if any identifier has the wrong shape or comes from an unknown key epoch, or if any distinct value of a free-text column matches an email, phone, possessive or localized device-name, UUID or HealthKit source bundle pattern. That scan is complete, not sampled: it runs over the distinct values of every descriptor column.
- Staging parts, manifests and raw run reports carry Firebase uids. They live in a private state location; only Parquet, the validation report and a sanitized summary are written to the lake, and `promote` refuses a lake in the same bucket as the state.

### Output contract

One table per sample type with the same common columns, BigQuery-compatible types only. Timestamps are `TIMESTAMP` in UTC at millisecond precision, with the original numeric offset in `utc_offset_min` and the IANA zone in `timezone` when it agrees with that offset. Measured values are always `FLOAT64` in the canonical UCUM unit of the type, percentages in percentage points (HealthKit's fraction-based percent is scaled by 100 on the legacy path); values outside the Grove catalog's domain, non-integral counts and non-finite numbers are dropped and counted, never kept. Samples that start before 1960 or after 2159 are dropped as `bad_time`, because BigQuery cannot partition them. Category values carry the Grove code and the HealthKit case. Every row carries `upload_kind`, `export_run_id` and `export_seq` for provenance.

| Column | Type | Meaning |
|---|---|---|
| `sample_id`, `source_record_id` | STRING | Grove opaque identities, minted with the export key |
| `participant_id` | STRING | pseudonymous participant |
| `sample_type`, `measurement_id` | STRING | HealthKit type and Grove measurement |
| `effective_start`, `effective_end` | TIMESTAMP | UTC; end is NULL for instants |
| `utc_offset_min`, `timezone` | INT64, STRING | offset and zone of the sample |
| `value`, `unit` | FLOAT64, STRING | quantity in the canonical unit |
| `value_code`, `value_source_code` | STRING | category value, Grove and HealthKit codes |
| `recording_method` | STRING | `manual-entry` when the user typed it |
| `device_manufacturer`, `device_model`, `device_hardware`, `device_software`, `device_firmware` | STRING | the recording device, when the app identifies one; never its name |
| `source_bundle_hash`, `source_version` | STRING | keyed hash of the writing app's bundle id and its version, when the app classifies the source |
| `writer_record_id`, `writer_version` | STRING | the app's Grove writer identity for third-party revisions |
| `study_revision`, `app_version`, `app_build` | INT64, STRING | study context |
| `converted_at` | TIMESTAMP | when the app converted the sample (the conversion Provenance's recorded time) |
| `upload_kind`, `from_archive` | STRING, BOOL | historical or live, bucket or Firestore |
| `export_run_id`, `export_seq` | STRING, INT64 | provenance |

Per-type facts (measurement id, unit, value domain, effective kind, allowed values, clinical code) come from the generated registry in [`mhc_export/schemas/`](mhc_export/schemas/README.md), which ships inside the package. The heart rate table adds `motion_context`.

Which types are exported at all is fixed by `mhc_export/schemas/coverage.json`, derived from the study definition: 63 HealthKit types are exported, 20 are deferred (blood pressure correlations, workouts, ECG with its symptoms, state of mind, clinical records) and characteristics such as date of birth are excluded. Every other type is skipped as not collected by the study, and the reason is recorded per unit. A type marked for export that the registry cannot export fails the run. GAD-7 assessments are exported as their total score only.

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
    --batch-end 2026-10-01T00:00:00Z --accept-legacy   # current dev data predates the Grove migration
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
    --envelope gs://state/runs/r2026-10/run.json --production
uv run mhc-export bq-load --lake gs://lake --project my-project --dataset mhc_export
```

The HMAC key must be at least 32 bytes; the Grove public conformance key is rejected outside tests. `--key-secret` reads it from Secret Manager, and `--production` refuses a local key id, the test key and file-based participant lookups. `--key-id` and `--key-epoch` become part of every identity and are recorded, without the secret, in every run report and lake summary; validation accepts ids from other export key epochs only when they are listed with `--accept-epoch`. The following fail the unit and therefore the run: unreadable or corrupt input, an exchange event that fails the Grove or HealthKit checks, legacy resources without `--accept-legacy`, and a writer version that is not a canonical decimal. `--tolerate-fatal N` allows a stated number and records it in the report. A run that exported nothing never validates if it read records or tolerated errors.

## Package layout

```text
mhc_export/
  io/          codec (zstd, zlib, plain JSON and CSV), blob stores (local, GCS, routed), prefix sync
  identity/    Grove opaque identities, participant lookup
  grove/       exchange event parser, HealthKit adapter mapping, typed view over an Observation
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
- BigQuery loads replace month partitions from the committed manifest's file list, so a retry never appends twice. Job ids derive from the destination partition and its files. Each destination's loaded dataset is recorded in `bigquery/{project}.{dataset}.json` only after every load and delete succeeded, and the next load diffs against that record. A failed or skipped load is therefore caught up later. Partitions the warehouse holds but the lake does not are deleted.
- Compaction refuses any staged or committed file whose columns differ from the type's schema, instead of filling the gap with NULL. A contract change therefore needs a rebuilt lake.
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
