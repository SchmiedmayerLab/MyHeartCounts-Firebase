<!--
This source file is part of the My Heart Counts project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->

# Export Pipeline: High-Level Overview

Scope for v1: **HealthKit records only** (from the storage archives and Firestore). SensorKit and questionnaires follow later as separate pipelines on the same framework. Companions: [data-routing.md](data-routing.md), [ios-datatypes.md](ios-datatypes.md). The data contract for every record is the [Grove FHIR standard](https://github.com/SchmiedmayerLab/grove-fhir); where this document restates a Grove rule, Grove wins.

## Goal

Scheduled, repeatable export of all collected HealthKit data (up to 10 TB of compressed archives, zstd plus legacy zlib, and the Firestore observation collections) into one-way anonymized, schema-enforced Parquet in a datalake bucket. Source data is read-only and stays intact. Every run can be paused, killed, or crashed at any point and resumed without loss or duplication.

## Decisions

Settled; the rest of this document elaborates on them.

| Topic | Decision |
|---|---|
| Data standard | Full compliance with Grove FHIR (Mobile envelope plus HealthKit adapter). Grove identifiers, retraction model, and time rules are adopted as-is. |
| Source | One private bucket, laid out as `{uid}/{yyyy}/{mm}/{sampleType}/…` after the migration, where year and month are the upload month (see [Migration](#migration)). |
| Grove identity | Until the app emits Grove itself, the server mints Grove identifiers from the HealthKit UUID as a standing upgrade step in every run. The export never rejects an input version; it upgrades it. |
| Sink | A separate, less restricted bucket holding only anonymized Parquet under a versioned prefix. |
| Compute | Pool of identical GCE Spot VMs pulling work from a queue. A local Mac mini is only for developer iteration on a small sample; egress cost and throughput rule it out for real runs. |
| Sharding | By user: a work unit is one user × one sample type; a worker leases all units of a user before moving on, so per-user dedup stays local to one machine. |
| Dedup | Per user, keyed on the Grove `source-output` identifier. |
| Recoverability | Immutable manifest, leased units, deterministic output names, staging then promote. |
| File size | 500 MB target per Parquet file after compaction. |
| Big-data stack | Not for v1. Plain Python workers (pyarrow, zstandard) for the transform; DuckDB for compaction and validation. Escalate to Spark on Dataproc only if a single type-month compaction no longer fits one VM. |
| Schedule | One run on the 20th of every month, exporting every upload of the previous calendar month. |
| Migration | The export reads only post-migration data. The migration runs once all questions here are closed. |

## Architecture

```mermaid
flowchart TD
    SCHED[Cloud Scheduler] --> ORCH[Orchestrator\nsmall function: builds manifest,\nboots worker VMs]
    subgraph PHI["Private GCP project"]
        SRC[(Source bucket\n{uid}/{yyyy}/{mm}/{sampleType}/)]
        FS[(Firestore\nHealthObservations_*)]
        MAP[(Lookup table\nuid to participant_id\nnever exported)]
        STATE[(Run state\nmanifest in GCS,\nunit leases in Firestore)]
        W1[GCE worker VMs\nSpot managed instance group,\nsized per run]
        SRC --> W1
        FS --> W1
        MAP --> W1
        STATE <--> W1
    end
    ORCH --> STATE
    ORCH --> W1
    subgraph LAKE["Datalake project"]
        STG[(Staging prefix\nper unit)] --> CMP[Compact\n500 MB files] --> VAL[Validate] --> FIN[(Datalake bucket\nParquet, hive-partitioned, v1/)]
        META[(Run reports\nfeeds dashboard)]
    end
    W1 --> STG
    W1 --> META
```

The workload is a bursty batch job (10 TB decompress + transform), which maps to a pool of on-demand VMs better than serverless limits. Because the pipeline is resumable by design, we can use cheap Spot VMs: preemption is just another crash. VMs boot from an instance template inside a managed instance group that the orchestrator sizes up at run start and back to zero when the manifest is exhausted (see [VM provisioning](#vm-provisioning)). Nothing runs between exports.

## Source layout and versions

- **Object path:** `{uid}/{yyyy}/{mm}/{sampleType}/{batchUuid}.json.zstd`. Year and month are the **upload month**, not the effective time of the samples. Historical batches from the bulk exporter span arbitrary ranges and the client should not have to split them; discovery works on creation time and Parquet partitions come from row content, so the path month is only a listing aid. Every batch is homogeneous in sample type.
- **Object metadata:** every object carries its MHC data version, Grove package version, and `upload_kind` (`historical` or `live`) in object metadata, written by the client or by the migration. Objects without metadata are treated as the pre-Grove version. The manifest records the version per unit and the transform dispatches on it.
- **Grove upgrade step:** the app does not emit Grove yet (see [Client gaps](#client-gaps-ios-main-as-of-2026-09-13)). Every run therefore starts a unit by upgrading its records to the Grove HealthKit profile in memory: mint `source-record` and `source-output` identifiers from the HealthKit UUID with the Secret Manager key, map the BDH extensions to Grove Device and study context, and drop what has no Grove mapping. The same code runs in the migration for the backlog and in the monthly run for anything the client still uploads in the old shape. Once the app emits Grove, the step becomes a no-op for those objects. The export therefore never fails a unit on version; it fails only on records it cannot upgrade.
- **Discovery index:** the Plan stage lists the bucket with a per-user prefix and writes the object list into the manifest. If listing 10 TB worth of objects becomes the slow step, switch discovery to a GCS Storage Insights inventory report, which is a daily CSV of all objects and generations.
- **Firestore:** `users/{uid}/HealthObservations_*` subcollections are listed per user during Plan. They hold live samples only; historical data is bucket-only.

## Run lifecycle (the core of pause/resume)

1. **Discover:** list source objects and Firestore documents with a creation time newer than the last run's watermark and older than the batch cutoff, the first day of the current month at 00:00 UTC (see [Schedule and settling](#schedule-and-settling)). Read-only.
2. **Plan:** write an immutable **manifest**: the run's complete list of work units. The manifest is the contract for the run; everything after this is stateless workers consuming it.
3. **Process:** each worker leases a unit, transforms it, writes Parquet parts to a staging prefix under a **deterministic name derived from the unit id**, marks the unit done. Crash or preemption: the lease expires and another worker redoes the unit; the deterministic output name makes redo overwrite, never duplicate. Pause: stop the VMs, state persists. Resume: start VMs, they continue with the remaining units.
4. **Compact:** per sample type and month, merge the staged per-unit parts into files of about 500 MB, sorted by `participant_id` then effective time. Deterministic given the same set of parts, so it is safe to redo.
5. **Validate:** schema check against the declared contract, row counts vs manifest expectations, null-profile audit, PHI spot-scan on a sample. A failed validation blocks promotion; nothing partial ever becomes visible.
6. **Promote:** atomically move compacted partitions into the versioned layout (`v1/...`), advance the watermark, write the run report.

Every stage is idempotent; re-running a finished run is a no-op. This is also the test strategy: the same pipeline runs against a fixture bucket in CI (golden-file tests for the transform, an end-to-end run on synthetic data) and in dry-run mode against production sources (discover + plan + validate, no writes).

### Manifest, work units, and leases

- **Manifest** lives at `runs/{run_id}/manifest.jsonl` in a state bucket in the private project. One line per unit: unit id, uid, sample type, list of source objects with generation numbers, Firestore collection path, data version, expected object count and byte size. Written once, never edited.
- **Unit** = one user × one sample type. Bounded memory (one type of one user fits in RAM even for ten years of heart rate), fine-grained retry, and dedup scope equals unit scope.
- **Leases** are Firestore documents `runs/{run_id}/units/{unit_id}` with `state`, `owner`, `lease_expires_at`, `attempts`. A worker claims a unit in a transaction that checks the lease is free or expired. Lease TTL is a few multiples of the median unit time; the worker renews while processing.
- **Sharding to VMs** is dynamic, not static: the queue is grouped by uid and a worker claims all units of one uid in order before claiming the next uid. VMs are identical and only read the run id from instance metadata. There is no shard table to keep in sync and no VM ever needs to know how many others exist. A static `hash(uid) mod N` assignment is the fallback if contention on Firestore transactions ever becomes measurable; it is not expected at the scale of a few dozen VMs.
- **Output name** of a staged part: `staging/{run_id}/{sampleType}/{year}/{month}/{unit_id}.parquet`. A redone unit overwrites exactly its own parts.

## One-way anonymization

- **Users:** lookup table in the private GCP project maps Firebase uid to a random external UUID (`participant_id`). Created on first sight of a user, stable forever, never exported. Re-identification is possible only through this table; deleting a row severs the link.
- **Samples:** the sample id in the export is the Grove `source-output` identifier, an HMAC of the source record identity with a key held in Secret Manager. Deterministic, so dedup works and the future cross-account question "was this sample ever in the dataset" stays answerable, but the original HealthKit UUID is not recoverable from the export. The Grove `source-record` identifier is exported alongside it. A separate export key is not needed; the Grove key already gives one-way identity.
- **Link back to the private record:** every Parquet row carries `sample_id` and `source_record_id`. Inside the private project the same HMAC can be recomputed from the original HealthKit UUID, so any exported row can be traced to its exact source object and record from the private side. The reverse direction does not exist: a holder of the Parquet cannot get from `sample_id` to the UUID, the uid, or the source object without the key and the lookup table. The private side keeps no separate row-to-sample table; the HMAC is the join.
- **Record contents:** allowlist projection (only known fields are copied into typed columns). Drops uid references, the HealthKit source name (contains the user's device name, e.g. "Lukas' Apple Watch"), bundle ids, the raw HealthKit metadata dictionary, and free text. Recording device model, manufacturer, hardware and software version are kept; they describe hardware, not people.

## Data standard (the BigQuery contract)

One declared schema per sample-type table, enforced at write time; the pipeline fails a unit rather than coerce. The field list per sample type is derived from the Grove HealthKit adapter mapping, not invented here: a column exists only for a FHIR path the adapter maps. Rules:

- **Static types**, BigQuery-compatible only (STRING, INT64, FLOAT64, BOOL, TIMESTAMP, DATE).
- **Nulls:** a missing value is a typed NULL. Never empty strings, never 0 or -1 sentinels, never absent columns.
- **One number format:** every measured value is cast to FLOAT64 (IEEE 754 double), whatever the JSON source looked like. Integers, floats, and numeric strings all become FLOAT64; a value that does not parse as a decimal number fails the unit rather than becoming NULL silently. NaN and infinity become NULL and are counted in the run report. Counts and indices that are integers by definition (`study_revision`, `export_seq`, `utc_offset_min`) are INT64. No STRING column ever holds a number. Decimal point only, no thousands separators, no locale.
- **Status:** only `status == final` rows are exported. Other statuses are counted in the run report and dropped.
- **Provenance:** `from_archive` flag (archive vs Firestore origin) and `export_run_id` on every row.
- **Ongoing counter:** a monotonic `export_seq` per row for auditing and incremental diffs.
- **Units** normalized to one canonical UCUM code per sample type, declared in the per-type spec. A value arriving in a different UCUM unit is converted; a value in an unknown unit fails the unit. The `unit` column therefore has exactly one value per table and exists for self-description.
- **Versioned layout:** breaking schema changes mean a new top-level prefix (`v1/`, `v2/`); within a version, changes are additive only.

### Common columns

Every sample-type table starts with these columns; type-specific value columns follow.

| Column | Type | Source |
|---|---|---|
| `sample_id` | STRING | Grove `source-output` identifier |
| `source_record_id` | STRING | Grove `source-record` identifier |
| `participant_id` | STRING | lookup table |
| `sample_type` | STRING | HealthKit type identifier |
| `effective_start` | TIMESTAMP | `effectiveDateTime` or `effectivePeriod.start`, UTC |
| `effective_end` | TIMESTAMP | `effectivePeriod.end`, NULL for instants |
| `utc_offset_min` | INT64 | numeric offset from the source, NULL when the source had none |
| `timezone` | STRING | IANA name from the Grove timezone extension, NULL when absent |
| `issued` | TIMESTAMP | `Observation.issued`, NULL when the platform had no version timestamp |
| `value` | FLOAT64 | `valueQuantity.value` (quantity types) |
| `unit` | STRING | UCUM code |
| `value_code` | STRING | `valueCodeableConcept` code (category types) |
| `recording_method` | STRING | Grove recording method extension |
| `device_model`, `device_manufacturer`, `device_hardware`, `device_software` | STRING | Grove recording Device |
| `app_version`, `app_build` | STRING | Grove application Device |
| `study_revision` | INT64 | Grove study context |
| `writer_version` | STRING | source writer version when the platform supplies one |
| `upload_kind` | STRING | `historical` or `live`, from object metadata |
| `from_archive` | BOOL | provenance |
| `export_run_id` | STRING | provenance |
| `export_seq` | INT64 | audit counter |

Workouts, ECG, and state of mind need their own value columns and are specified when their types are added; v1 starts with quantity and category types.

### Output layout and file sizing

- **Path:** `v1/{sampleType}/year=YYYY/month=MM/part-{run_id}-{n}.parquet`, hive-partitioned on effective start time. There are no per-participant folders in the output: they leak cohort size, produce millions of tiny files, and defeat partition pruning in BigQuery. Per-participant grouping is a staging concern only.
- **File size:** 500 MB target after compaction, zstd-compressed Parquet, rows sorted by `participant_id` then `effective_start`. Each file also carries its covered timespan and participant count in the Parquet key-value metadata.
- **Index:** a BigQuery external table (or BigLake) per sample type over the hive layout is the query index; nothing else needs to be maintained.

### Deduplication

- **Scope:** per user, inside one unit. Two users can never share a `sample_id`, so cross-user dedup is unnecessary.
- **Key:** Grove `source-output` identifier. Grove derives it from the source record identity, so the same HealthKit sample yields the same key whether it arrived in the historical archive, a live archive, or Firestore.
- **Precedence on collision:** highest `writer_version` wins where the platform provides one; then the latest `issued`; then Firestore over archive. Grove also states that a receiver supersedes on version, so this is the standard's rule, not ours.
- **Content tuple** (type, start, end, value, unit, device) is *not* a merge key. It is computed as a validation metric: the count of rows sharing a tuple but not a `sample_id` is reported per run, so a device restore that re-mints HealthKit UUIDs becomes visible without silently merging distinct samples.

### Time handling

- All timestamps are UTC TIMESTAMP at millisecond precision, matching Grove's rounding rule. The numeric offset is exported as `utc_offset_min` and the IANA zone as `timezone`, both nullable.
- Grove forbids inventing an offset. The app attaches the device's *current* time zone to every sample it converts, including ten-year-old historical ones, so the offset on a historical row is not evidence of where the sample was recorded. Rule: for `upload_kind = historical` the export sets `utc_offset_min` and `timezone` to NULL unless the sample carries HealthKit's own time-zone metadata key, in which case that value is used. Live samples keep the device offset, since the device was in that zone within the three-day buffer window. There is no `time_is_local` flag because the NULL already says it.
### Schedule and settling

- **Cadence:** Cloud Scheduler triggers one run on the 20th of every month at 02:00 UTC.
- **Batch:** a run exports every source object and Firestore document whose creation time falls between the previous watermark and the first day of the current month at 00:00 UTC. In other words, the run on the 20th exports the previous calendar month's uploads. The 19 to 20 days between month end and run start cover the on-device buffer of about three days plus upload lag, so nothing needs a separate settling parameter.
- **Watermark:** after a successful promote, the watermark moves to that month boundary. A skipped or failed month is not lost: the next run's batch simply spans two months.
- **Partitions stay open:** partitions are keyed on effective time, not upload time. A historical backfill uploaded in September lands in partitions from years ago, so any partition may receive new part files in any run. Consumers must read a partition's full file set; nothing is ever considered closed.
- **Manual runs:** the orchestrator accepts an explicit batch end for a re-run or an out-of-cycle export; a manual run with the same batch end as a finished run is a no-op.

## Eligibility and edge cases

- **Historical uploads:** see [Historical archive uploads](#historical-archive-uploads).
- **Ineligibility flag:** users can be marked ineligible for all or parts of the export (withdrawn, consent version, region); the Plan stage excludes them.
- **Deletions:** after the migration, removals arrive as Grove retraction bundles addressed by `source-output` identifier. The pre-migration `healthDeletions/*.csv` backlog and `entered-in-error` observations are converted to the same tombstone form by the migration. Tombstones are applied per unit before staging and again at promote for late arrivals.
- **Dedup:** see [Deduplication](#deduplication).

### Historical archive uploads

The historical backfill is uploaded batch by batch across many app sessions and can take weeks, stall for months, or never finish. The export does not wait for it. Every run exports whatever has arrived, and because partitions are keyed on effective time, a historical batch uploaded in September lands in partitions from years ago. What the export needs is not a gate but a reliable statement of *how complete* each user's history is, so that analyses can select complete users and the dashboard can tell "nothing to upload" from "still uploading".

**Completion flag on the user document.** Written by the app, read by the export at Plan time.

| Field | Type | Meaning |
|---|---|---|
| `historicalUploadState` | `notStarted`, `inProgress`, `complete`, `unknownLegacy` | Overall state of the bulk export session |
| `historicalUploadCompletedAt` | timestamp | When the last historical file was confirmed uploaded; NULL unless `complete` |
| `historicalUploadRangeStart`, `historicalUploadRangeEnd` | timestamp | The window the bulk exporter was asked to cover |
| `historicalUploadTypesComplete` | list of sample type ids | Types whose backfill is confirmed uploaded |
| `historicalUploadSessionId` | string | Identifier of the current bulk export session |

Rules for the app:

1. `complete` means *uploaded*, not *exported from HealthKit*. The flag is set only after `ManagedFileUpload` has confirmed the last historical file in the bucket. Local staging is not enough; an uninstall between staging and upload would otherwise produce a complete flag with missing data.
2. Completion is tracked per sample type because the bulk exporter runs per type and because a user can grant additional HealthKit types later, which starts a new backfill for those types only. The overall state is `complete` only when every type in the current study definition is in the list.
3. A new bulk export session, whether from a reinstall, a re-enrollment, or a newly granted type, resets the overall state to `inProgress`, writes a new session id, and removes the affected types from the list. Re-uploaded samples deduplicate through the Grove identifiers, so a restart never creates duplicates in the export.
4. Users enrolled before the flag existed are `unknownLegacy` until an updated app runs. The bulk exporter persists its own progress, so on first launch after the update the app can evaluate that state and set the flag retroactively without re-uploading anything. Users who never launch the updated app stay `unknownLegacy`, and the export reports them as such rather than guessing.

What the export does with it:

- **Plan** snapshots the flag for every eligible user into the manifest.
- **Every row** carries `upload_kind` (`historical` or `live`), preserved by the migration from the old prefix and written by the client as object metadata alongside the data version.
- **A `participants` table** in the datalake, one row per participant per run, holds `historical_state`, `historical_completed_month`, `historical_types_complete`, and the covered range. Dates are truncated to month so the table adds no quasi-identifier beyond what the samples already reveal. Analyses that need full history join on `participant_id` and filter to `complete`.
- **The run report** counts users per state and per type, which is the dashboard's "archive still uploading" figure.
- **No gating.** A user's historical rows are exported as they arrive even while `inProgress`. Withholding them would only delay the data and would not make it more complete; the flag is the completeness signal.

## What the client can do to make the pipeline's life easier

Ordered by value; all are requests to the iOS team, none are pipeline blockers.

1. Upload into the `{uid}/{yyyy}/{mm}/{sampleType}/` layout directly, with data version, Grove package version, and `upload_kind` in object metadata.
2. Mint Grove identifiers on device so archive and Firestore copies of one sample are byte-identical in identity.
3. Emit retraction bundles instead of deletion CSVs.
4. Keep batches homogeneous and bounded (one type, at most a few thousand samples or a few MB) so a unit's object count predicts its size.
5. Write the historical completion flag per type, and only after the upload of the last file is confirmed; backfill it for legacy users on first launch after the update.
6. **Device heartbeat:** background-task execution timestamps written to Firebase let the dashboard distinguish "device offline" from "no data".

## Tooling

- **Workers:** Python. pyarrow is the mature Parquet writer and the natural BigQuery companion; the transform is a pure function from compressed bytes to a pyarrow table and is tested with golden files. Decompression via `zstandard`, with a magic-byte sniff to fall back to zlib for legacy archives.
- **Compaction and validation:** DuckDB on the same VM, reading the staged parts for one type-month and writing 500 MB files. It runs out-of-core, so a large type-month does not need to fit in RAM.
- **Orchestration:** one small Cloud Function for Discover and Plan plus VM boot, triggered by Cloud Scheduler. Written in TypeScript to stay with the rest of `functions/`.

### VM provisioning

1. **Image:** the worker is a container in Artifact Registry. The instance template uses Container-Optimized OS, a Spot provisioning model, a 32 vCPU / 128 GB shape, a local SSD for staging spill, and a service account that can read the source bucket, read and write run state, read the pepper secret, and write only the staging prefix of the datalake bucket.
2. **Start:** Cloud Scheduler calls the orchestrator. It writes the manifest, then resizes a regional managed instance group built from that template from 0 to N, where N = min(N_max, ceil(unit_count / units_per_vm)). The run id is passed as instance metadata; workers read nothing else.
3. **Work:** each VM boots, pulls the worker image, and loops on lease → process → mark done until a lease attempt finds no pending unit.
4. **Preemption:** the group recreates a preempted VM automatically; the expired lease makes another worker redo the unit. No operator action.
5. **Stop:** a worker that finds the queue empty exits its loop and idles. Cloud Scheduler also calls the orchestrator every 15 minutes while a run is active; when every unit is done or permanently failed the orchestrator runs Compact, Validate, and Promote, then resizes the group to 0. If units are all leased but no heartbeat has moved for longer than the lease TTL, it reports a stuck run instead of scaling.
6. **Pause:** resize the group to 0 by hand. Resume: resize it back up; the manifest and leases are untouched.

Why a managed instance group and not bare `bulkInsert`: the group replaces preempted Spot VMs for free, which keeps the pool at full size for the whole run without the orchestrator tracking individual instances. Workers therefore do not delete themselves; the group would only recreate them.
- **No Spark, Beam, or Dataproc in v1.** The job is embarrassingly parallel per user with no shuffle until compaction, and compaction is per type-month. A cluster stack would add JVM packaging, a second deployment model, and less direct control over Grove validation, for no throughput gain at this size. Revisit if a single type-month compaction exceeds one VM's disk, or if a join across types becomes part of the export.
- **Local Mac mini:** useful for iterating on the transform against a sampled subset copied once. Not for full runs: reading 10 TB out of GCS costs more than the VM pool, and one machine has a fraction of the aggregate bandwidth.

## Migration

The current bucket layout (`users/{uid}/liveHealthSamples/…`, `historicalHealthSamples/…`, `healthDeletions/…`) and the current FHIR shape predate Grove. A one-time migration rewrites every object into the source layout above, upgrades each record to the Grove Mobile and HealthKit profiles, mints Grove identifiers, converts deletion CSVs to retraction tombstones, stamps the data version, and records `upload_kind` from the old `historicalHealthSamples` and `liveHealthSamples` prefixes. It sets `historicalUploadState = unknownLegacy` on every user document that has no flag yet. It runs on the same worker framework (manifest, leases, deterministic outputs) and reuses the Grove upgrade step from the monthly run, so there is exactly one implementation of the old-to-Grove mapping. It runs after the open questions below are closed. Because the monthly run can also upgrade old-shape objects, the migration is not a hard prerequisite for the first export; it is what lets the export stop carrying the old layout listing.

## Observability and dashboard

- Workers heartbeat into the run state; the run report records per-stage and per-unit timing (the "measure function time" requirement), rows in/out, dedup and tombstone counts, tuple-collision counts, and failures.
- Run reports plus discovery stats feed the study dashboard: active users over time, per-type sample volumes over time, live vs archive coverage.

## Out of scope

1. SensorKit and questionnaire pipelines (same framework, own schemas and PHI review).
2. Third-party wearables (Fitbit, Withings) as an additional archive source; the manifest model absorbs new sources without redesign.
3. Lifecycle idea from the notes ("move data older than one month to the datalake, delete in live"): conflicts with "originals stay intact" and is a separate retention decision, not part of the export pipeline.
4. The in-app `stats/` documents are supporting data and are never exported.
5. Cross-account sample cross-check (enabled by the deterministic sample hash, not built in v1).

## Client gaps (iOS main as of 2026-09-13)

Checked against the iOS repository at commit 4c272c0. Ordered by size. None of these block starting the pipeline code; items 1 and 5 have a server-side workaround built into the design, items 2 to 4 gate only the point at which the old layout listing can be retired.

| # | Gap | Effect on the pipeline | Client change |
|---|---|---|---|
| 1 | No Grove output. Resources carry the raw HealthKit UUID as `id` and `identifier`, BDH extensions, no typed identifiers, no Device or Provenance resources, and `issued` is the ingestion time. | The Grove upgrade step mints identities server-side. `issued` cannot be trusted as a platform version timestamp until the app changes. | The Spezi to Grove migration in the app. Largest item, own project. |
| 2 | No object metadata on uploads. The upload module accepts a metadata dictionary; neither the live nor the historical path passes one. | Objects without metadata are treated as pre-Grove. | Pass data version, Grove package version, and `upload_kind` in `ManagedFileUpload.stage`. Small. |
| 3 | Old upload layout. Files go to `users/{uid}/liveHealthSamples`, `historicalHealthSamples`, and `healthDeletions` with a random-UUID file name and no year or month. | The migration rewrites the backlog; new uploads keep arriving in the old layout until the client changes, so discovery lists both layouts. | Write to `{uid}/{yyyy}/{mm}/{sampleType}/` with upload month. Small. |
| 4 | No historical completion flag. Session state lives in memory and on the account sheet only. | Every user is `unknownLegacy` in the `participants` table until the flag ships. | Implement [Historical archive uploads](#historical-archive-uploads). Hooks exist: session id and restoration info, per-category upload progress and quiescence. Per-type completion depends on what the SpeziHealthKitBulkExport session exposes. Medium. |
| 5 | Deletion CSVs have no consumer. The app uploads `{type}_{uuid}.csv.zstd` with `sampleType`, `sampleId`, `timestamp`; `sampleId` is the HealthKit UUID and `timestamp` is the buffer-drain time. Nothing server-side reads them. The server's own entered-in-error flow is an admin callable the app never invokes. | The pipeline reads the CSVs as tombstones and maps `sampleId` through the same HMAC as the Grove upgrade step. | Emit Grove retraction bundles instead of CSVs. Part of item 1. |
| 6 | Historical offsets are the device's current zone. One conversion path for live and historical samples attaches today's time zone to every record. | Handled by the rule in [Time handling](#time-handling). | With Grove, attach an offset only when the source supplies one. Part of item 1. |
| 7 | Clinical records land in `liveHealthSamples` inside the version envelope. | The transform skips them explicitly instead of failing the unit. The routing doc's claim that they go to Firestore is stale. | Route to a separate prefix or pause collection, as [data-routing.md](data-routing.md) already proposes. |
| 8 | Firestore holds almost no HealthKit data. All HealthKit types use the local queue and the bucket; only custom types and the timed walking test go directly to Firestore. | Firestore is a minor source for v1 and its read cost is small. The eight-dashboard-types plan in data-routing.md is not implemented. | None for the export. |

Already matching: homogeneous zstd JSON batches per type, three-day on-device retention, ten years of historical range from the study definition, `hasWithdrawnFromStudy` on the user document, and only zstd in the current code, so legacy zlib objects can come only from older app versions.

## Requests to the cloud admin

Everything below needs someone with owner rights on the Firebase project and the ability to create a project. Grouped by when it is needed.

**Before the discovery spike (read-only)**

1. Confirm the source bucket's location, storage class, and any lifecycle rules. A Nearline, Coldline, or Archive class adds retrieval fees of 0.01 to 0.05 USD per GB on every full read, which at 15 TB is 150 to 750 USD per run on top of far more expensive per-object requests, and the location decides which region the VMs go in.
2. A read-only service account or group with `storage.objectViewer` on the source bucket and `datastore.viewer` on Firestore, for the spike and for dry runs.
3. Enable APIs on the private project: Compute Engine, Artifact Registry, Secret Manager, Cloud Scheduler, Storage Insights.

**Before the draft run**

4. Create the datalake project, or a dedicated bucket if a project is too much for v1. Same region as the source bucket, Standard class, uniform bucket-level access, no public access, object versioning on so a bad promote is reversible.
5. A state bucket in the private project for manifests and run reports, and a Firestore security rule that denies client access to the `runs/` collection and the lookup table collection.
6. Secret Manager secret for the HMAC key, with a documented key id and epoch, readable only by the worker service account.
7. Worker service account: `storage.objectViewer` on the source bucket, `datastore.user` on the private project, `secretmanager.secretAccessor` on the key, and object write limited to the staging prefix of the datalake bucket. If IAM conditions on a prefix are too fiddly, use a separate staging bucket.
8. Orchestrator service account: manage the managed instance group, act as the worker service account, read and write the state bucket.
9. Artifact Registry repository for the worker image, and a way for CI to push to it (workload identity federation from GitHub Actions).
10. Spot vCPU quota in the chosen region for at least 640 vCPUs of the n2d family plus local SSD quota, and confirmation that Spot is not blocked by org policy.
11. VPC: subnet with Private Google Access so workers need no external IP, and a firewall that allows nothing inbound.

**Before the first production run and for the researchers**

12. BigQuery dataset in the datalake project for the external tables, a billing project for researcher queries, and a Google group for read access with `storage.objectViewer` on the datalake bucket and `bigquery.dataViewer` plus `bigquery.jobUser`.
13. Data access audit logs on the datalake bucket, so reads are attributable.
14. Budget alert on both projects with labels on the VMs, so a runaway run is noticed within a day.
15. Decide whether the datalake bucket is requester-pays, which moves download egress to the consumer.
16. Cloud Scheduler job for the 20th, once the orchestrator is deployed.

## Questions for the researchers

Answers here change the schema, so they belong before the per-type field specs are frozen.

1. **Which sample types first?** The doc starts with quantity and category types. Are workouts, sleep, or ECG needed in the first release?
2. **Which columns matter?** In particular whether device model and software version, study revision, and recording method are needed, or whether a leaner table is preferred.
3. **Canonical units per type.** For example metres versus kilometres for distance, kilocalories versus kilojoules for energy. One unit per table, chosen once.
4. **Local time.** Is UTC plus offset sufficient, or do analyses need local calendar days for step counts and sleep? If the latter, a `local_date` column derived from the offset is cheap to add, but is NULL for historical rows.
5. **Historical completeness.** Will analyses filter to participants with a complete history, and is the `participants` table shape sufficient for that?
6. **Deletions.** When a sample is retracted, should it disappear from the datalake at the next promote, or stay with a tombstone flag so earlier analyses remain reproducible?
7. **Reproducibility.** Does a paper need to cite a fixed dataset version? If so, every run also writes a snapshot manifest listing the exact file set, and analyses pin to a run id. Cheap to add now, awkward to add later.
8. **Access path.** BigQuery external tables, direct Parquet download, or both? Which tools: Python, R, DuckDB?
9. **PHI review.** Which exported fields do they consider quasi-identifying in combination, and is there a small-cell concern for rare sample types?
10. **Aggregates.** Are per-sample rows enough, or are daily aggregates per participant also expected from the pipeline?

## Implementation plan

What can start now versus what waits on whom. The transform and CLI need only sample data; the draft run needs the admin items 4 to 9; the first production run needs the Grove decision above, which is now made, and nothing from the iOS side.

| Step | Depends on | Output |
|---|---|---|
| 1. Close decisions | This document, the two calls | Signed-off doc, answered researcher questions |
| 2. Discovery spike | Admin items 1 to 3 | Object counts and sizes per prefix, compression formats, real samples of three quantity types, confirmation of the zlib and offset claims |
| 3. Per-type field specs | Step 2, researcher answers 1 to 4 | One schema file per sample type in the repo, derived from the Grove HealthKit mapping |
| 4. Transform library | Step 3 | Pure function: compressed bytes to FHIR array to Grove upgrade to pyarrow table. Golden-file tests. Includes the CSV tombstone reader and clinical-record skip. |
| 5. Worker CLI | Step 4 | Dry-run by default, processes a list of units from a local manifest into a local or GCS staging prefix |
| 6. Draft run | Steps 5, admin items 4 to 9 | Parquet for a handful of users in the staging prefix, inspected with DuckDB and a BigQuery load. **This is the first milestone worth showing.** |
| 7. Compaction, validation, promote | Step 6 | 500 MB files in `v1/`, run report |
| 8. Orchestrator, instance group, scheduler | Step 7, admin items 10, 11, 16 | Unattended monthly run |
| 9. Migration | Step 8 | Backlog rewritten into the new layout with Grove identities and tombstones |
| 10. First production run | Steps 8 and 9, admin items 12 to 15 | Full datalake, researcher access |
| iOS work, in parallel | Client gaps 2, 3, 4, then 1 | Not on the critical path for step 10 because of the server-side upgrade step |

Step 4 is the bulk of the engineering and is independent of every admin item, so it is the right thing to work on while access is being set up.

## Open questions

1. **Per-type field specs.** Each exported sample type needs its column list and cast types written out against the Grove HealthKit adapter mapping. Quantity and category types first. Blocked on researcher questions 1 to 4.
2. **Legacy zlib archives.** No zlib path exists in current app code, so any zlib objects come from old app versions. Confirm by sniffing magic bytes during the discovery spike; if none, drop the fallback.
3. **Datalake project.** Project id, bucket, IAM, and who gets read access are with the cloud admin (requests 4 and 12).
4. **Per-type completion in the bulk exporter.** Whether the SpeziHealthKitBulkExport session exposes per-type progress decides whether the completion flag can be per type or only overall.
5. **Deletions and reproducibility model.** Hard delete at promote versus tombstone flag, and whether runs are citable snapshots. Researcher questions 6 and 7.
6. **Access model.** BigQuery, bucket, or both, and requester-pays. Researcher question 8 and admin request 15.
