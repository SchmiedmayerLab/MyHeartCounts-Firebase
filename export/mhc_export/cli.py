# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from mhc_export.config import IdentityConfig, load_key, new_key_hex
from mhc_export.identity.participants import LocalParticipantLookup
from mhc_export.io.blobstore import LocalBlobStore, RoutedStore, read_uri, store_for, sync_prefix, write_uri
from mhc_export.run.compact import DEFAULT_TARGET_BYTES, compact_run
from mhc_export.run.inspect import format_summary, sample_rows, summarize
from mhc_export.run.manifest import dump_manifest, load_manifest
from mhc_export.run.models import RunReport, UnitResult
from mhc_export.run.promote import promote_run
from mhc_export.run.unit import Deps, process_unit
from mhc_export.run.validate import validate_run
from mhc_export.sources.bucket import plan_units
from mhc_export.transform.specs import default_registry

log = logging.getLogger("mhc_export")


def _add_key_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--key-hex", help="32+ byte HMAC key as hex (or MHC_EXPORT_KEY_HEX)")
    parser.add_argument("--key-file", type=Path, help="file containing the hex key")
    parser.add_argument("--key-id", default="local")
    parser.add_argument("--key-epoch", type=int, default=1)
    parser.add_argument(
        "--allow-test-key", action="store_true", help="accept the Grove public conformance key (tests only)"
    )


def cmd_new_key(_: argparse.Namespace) -> int:
    print(new_key_hex())
    return 0


def cmd_run_local(args: argparse.Namespace) -> int:
    key = load_key(
        key_hex=args.key_hex,
        key_file=args.key_file,
        key_id=args.key_id,
        epoch=args.key_epoch,
        allow_test_key=args.allow_test_key,
    )
    source = LocalBlobStore(args.source)
    out_root: Path = args.out
    out_root.mkdir(parents=True, exist_ok=True)
    out_store = LocalBlobStore(out_root)
    registry = default_registry()
    uids = set(args.uid) if args.uid else None
    types = set(args.sample_type) if args.sample_type else None
    planned = plan_units(source.list(""), uids=uids, sample_types=types)
    units = planned[: args.limit_units] if args.limit_units else planned
    filtered = bool(uids or types or args.limit_units)
    manifest_path = out_root / "runs" / args.run_id / "manifest.jsonl"
    write_uri(str(manifest_path), dump_manifest(units))
    log.info("planned %d units from %s%s", len(units), args.source, " (filtered)" if filtered else "")
    deps = Deps(
        store=RoutedStore(source, out_store),
        registry=registry,
        identity=IdentityConfig(key),
        participants=LocalParticipantLookup(out_root / "private" / "participants.json"),
        staging_prefix=f"staging/{args.run_id}",
        run_id=args.run_id,
    )
    phases = set(args.phases.split(","))
    report_path = out_root / "runs" / args.run_id / "report.json"
    if "work" in phases:
        report, unit_results = _process_all(units, deps, args.run_id, planned_units=len(units), filtered=filtered)
        payload = json.dumps({"report": report.model_dump(), "units": unit_results}, indent=1, default=str)
        write_uri(str(report_path), payload.encode())
        print(_summary_line(report))
        print(f"report: {report_path}")
        if report.units_failed:
            return 1
    staging_root = out_root / "staging" / args.run_id
    compacted_root = out_root / "compacted" / args.run_id
    if "compact" in phases:
        results = compact_run(
            staging_root, compacted_root, run_id=args.run_id, target_bytes=args.target_bytes, registry=registry
        )
        print(f"compacted {len(results)} type-months into {sum(len(r.files) for r in results)} files")
    validation_path = out_root / "runs" / args.run_id / "validation.json"
    if "validate" in phases:
        run_report = json.loads(report_path.read_text())
        manifest_units = load_manifest(manifest_path.read_bytes())
        uids = {u.uid for u in manifest_units}
        validation = validate_run(
            compacted_root, run_report, run_id=args.run_id, uids=uids, registry=registry, manifest=manifest_units
        )
        validation_path.write_text(validation.model_dump_json(indent=1))
        _print_validation(validation)
        if not validation.ok:
            return 2
    if "promote" in phases:
        lake_root = out_root / "lake"
        lake_root.mkdir(exist_ok=True)
        result = promote_run(
            compacted_root,
            LocalBlobStore(lake_root),
            "",
            run_id=args.run_id,
            batch_end=args.batch_end,
            validation=json.loads(validation_path.read_text()),
            run_report=json.loads(report_path.read_text()),
        )
        print(
            f"promoted {result.copied} files ({result.skipped} already present) into {lake_root}; "
            f"snapshot {result.snapshot_uri}"
        )
    return 0


def _print_validation(validation) -> None:
    status = "PASSED" if validation.ok else "FAILED"
    print(
        f"validation {status}: {len(validation.checks)} checks, {validation.rows_total} rows, {validation.seconds:.1f}s"
    )
    for check in validation.failures():
        print(f"  FAIL {check.name} {check.sample_type or ''}: {check.detail}")


def cmd_compact(args: argparse.Namespace) -> int:
    staging = args.staging
    if staging.startswith("gs://"):
        if not args.work_dir:
            raise SystemExit("--work-dir is required when --staging is a gs:// prefix")
        local = Path(args.work_dir) / "staging" / args.run_id
        files = sync_prefix(store_for(staging, project=args.project), staging, local)
        log.info("synced %d staged parts from %s to %s", len(files), staging, local)
        staging = str(local)
    results = compact_run(
        Path(staging),
        Path(args.out),
        run_id=args.run_id,
        target_bytes=args.target_bytes,
        memory_limit=args.memory_limit,
        threads=args.threads,
        temp_dir=Path(args.temp_dir) if args.temp_dir else None,
        keys=set(args.key) if args.key else None,
    )
    total_files = sum(len(r.files) for r in results)
    total_bytes = sum(r.bytes for r in results)
    print(
        f"compacted {len(results)} type-months, {sum(r.rows for r in results)} rows -> "
        f"{total_files} files, {total_bytes / 1e6:.1f} MB"
    )
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    run_report = json.loads(read_uri(args.report, project=args.project))
    manifest_units = load_manifest(read_uri(args.manifest, project=args.project)) if args.manifest else None
    uids = {u.uid for u in manifest_units} if manifest_units else set()
    uids |= {unit_id.split(":", 1)[0] for unit_id in run_report.get("units", {})}
    validation = validate_run(Path(args.compacted), run_report, run_id=args.run_id, uids=uids, manifest=manifest_units)
    write_uri(args.out, validation.model_dump_json(indent=1).encode(), project=args.project)
    _print_validation(validation)
    return 0 if validation.ok else 2


def cmd_promote(args: argparse.Namespace) -> int:
    validation = json.loads(read_uri(args.validation, project=args.project))
    run_report = json.loads(read_uri(args.report, project=args.project))
    if args.lake.startswith("gs://"):
        lake, prefix = store_for(args.lake, project=args.project), args.lake
    else:
        lake, prefix = LocalBlobStore(args.lake), ""
    result = promote_run(
        Path(args.compacted),
        lake,
        prefix,
        run_id=args.run_id,
        batch_end=args.batch_end,
        validation=validation,
        run_report=run_report,
    )
    print(
        f"promoted {result.copied} files ({result.skipped} already present), {result.bytes / 1e6:.1f} MB; "
        f"snapshot {result.snapshot_uri}"
    )
    return 0


def _process_all(
    units: list, deps: Deps, run_id: str, *, planned_units: int | None = None, filtered: bool = False
) -> tuple[RunReport, dict[str, dict]]:
    started = time.monotonic()
    totals = UnitResult()
    per_type: dict[str, UnitResult] = {}
    done = failed = 0
    unit_results: dict[str, dict] = {}
    for i, unit in enumerate(units, 1):
        try:
            result = process_unit(unit, deps)
        except Exception as exc:  # noqa: BLE001
            log.exception("unit %s failed", unit.unit_id)
            failed += 1
            unit_results[unit.unit_id] = {"error": str(exc)}
            continue
        done += 1
        unit_results[unit.unit_id] = result.model_dump()
        totals.merge(result)
        per_type.setdefault(unit.sample_type, UnitResult()).merge(result)
        log.info(
            "[%d/%d] %s rows_in=%d rows_out=%d dedup=%d tomb=%d drops=%s warn=%s %.1fs%s",
            i,
            len(units),
            unit.unit_id,
            result.rows_in,
            result.rows_out,
            result.dedup_removed,
            result.tombstoned,
            result.drops or "",
            result.warnings or "",
            result.seconds,
            f" skipped={result.skipped_reason}" if result.skipped_reason else "",
        )
    report = RunReport(
        run_id=run_id,
        units_total=len(units),
        planned_units=planned_units,
        filtered=filtered,
        units_done=done,
        units_failed=failed,
        rows_out=totals.rows_out,
        totals=totals,
        per_sample_type=per_type,
        seconds=time.monotonic() - started,
    )
    return report, unit_results


def _summary_line(report: RunReport) -> str:
    return (
        f"run {report.run_id}: {report.units_done} units done, {report.units_failed} failed, "
        f"{report.rows_out} rows, {len(report.totals.parts)} parts, {report.seconds:.0f}s"
    )


def cmd_plan(args: argparse.Namespace) -> int:
    store = store_for(args.source, project=args.project)
    uids = set(args.uid) if args.uid else None
    types = set(args.sample_type) if args.sample_type else None
    units = plan_units(
        store.list(args.source), uids=uids, sample_types=types, batch_start=args.batch_start, batch_end=args.batch_end
    )
    write_uri(args.manifest, dump_manifest(units), overwrite=args.force, project=args.project)
    total_bytes = sum(u.expected_bytes for u in units)
    print(
        f"planned {len(units)} units, {sum(len(u.objects) for u in units)} objects, "
        f"{total_bytes / 1e9:.2f} GB -> {args.manifest}"
    )
    return 0


def cmd_work(args: argparse.Namespace) -> int:
    key = load_key(
        key_hex=args.key_hex,
        key_file=args.key_file,
        key_id=args.key_id,
        epoch=args.key_epoch,
        allow_test_key=args.allow_test_key,
    )
    manifest_units = load_manifest(read_uri(args.manifest, project=args.project))
    units = manifest_units
    if args.unit_id:
        wanted = set(args.unit_id)
        units = [u for u in units if u.unit_id in wanted]
    if args.limit_units:
        units = units[: args.limit_units]
    filtered = bool(args.unit_id or args.limit_units)
    source_root = units[0].objects[0].uri if units and units[0].objects else args.staging
    read_store = store_for(source_root, project=args.project)
    if args.staging.startswith("gs://"):
        write_store = store_for(args.staging, project=args.project)
        staging_prefix = f"{args.staging.rstrip('/')}/staging/{args.run_id}"
        report_uri = f"{args.staging.rstrip('/')}/runs/{args.run_id}/report.json"
    else:
        write_store = LocalBlobStore(args.staging)
        staging_prefix = f"staging/{args.run_id}"
        report_uri = str(Path(args.staging) / "runs" / args.run_id / "report.json")
    participants = LocalParticipantLookup(Path(args.participants)) if args.participants else None
    if participants is None:
        from mhc_export.identity.participants import FirestoreParticipantLookup

        participants = FirestoreParticipantLookup(project=args.project)
    deps = Deps(
        store=RoutedStore(read_store, write_store),
        registry=default_registry(),
        identity=IdentityConfig(key),
        participants=participants,
        staging_prefix=staging_prefix,
        run_id=args.run_id,
        firestore=_firestore_source(units, args.project),
    )
    log.info("working %d units from %s into %s", len(units), args.manifest, staging_prefix)
    report, unit_results = _process_all(units, deps, args.run_id, planned_units=len(manifest_units), filtered=filtered)
    report_uri = f"{args.staging.rstrip('/')}/runs/{args.run_id}/report.json"
    write_uri(
        report_uri,
        json.dumps({"report": report.model_dump(), "units": unit_results}, indent=1, default=str).encode(),
        project=args.project,
    )
    print(_summary_line(report))
    print(f"report: {report_uri}")
    return 1 if report.units_failed else 0


def cmd_inspect(args: argparse.Namespace) -> int:
    print(format_summary(summarize(args.prefix)))
    if args.show:
        for sample_type in args.show:
            print(f"\n{sample_type}, newest rows:")
            print(sample_rows(args.prefix, sample_type, args.limit))
    return 0


def cmd_bq_load(args: argparse.Namespace) -> int:
    from mhc_export.run.bigquery import load_gcs_prefix, load_local_prefix

    if str(args.prefix).startswith("gs://"):
        loaded = load_gcs_prefix(str(args.prefix), args.project, args.dataset, replace=not args.append)
    else:
        loaded = load_local_prefix(Path(args.prefix), args.project, args.dataset, replace=not args.append)
    for table, rows in loaded.items():
        print(f"{table}: {rows} rows")
    return 0


def _firestore_source(units: list, project: str | None):
    if not any(u.firestore_collection for u in units):
        return None
    from mhc_export.sources.firestore import FirestoreSource

    return FirestoreSource(project=project)


def _iso_datetime(text: str) -> datetime:
    value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mhc-export", description="My Heart Counts HealthKit export pipeline")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("new-key", help="print a fresh random HMAC key as hex")
    p.set_defaults(func=cmd_new_key)

    p = sub.add_parser(
        "run-local", help="plan + process every unit from a local directory into a local output directory"
    )
    p.add_argument("--source", type=Path, required=True, help="directory laid out like the bucket (users/{uid}/...)")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--uid", action="append")
    p.add_argument("--sample-type", action="append")
    p.add_argument("--limit-units", type=int)
    p.add_argument("--phases", default="work,compact,validate,promote", help="comma-separated subset to run")
    p.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES, help="compaction file size target")
    p.add_argument("--batch-end", type=_iso_datetime, help="watermark value written on promote")
    _add_key_args(p)
    p.set_defaults(func=cmd_run_local)

    p = sub.add_parser("compact", help="merge staged parts of each type-month into files of about --target-bytes")
    p.add_argument("--staging", required=True, help="local staging/{run_id} directory")
    p.add_argument("--out", required=True, help="local compacted/{run_id} directory")
    p.add_argument("--run-id", required=True)
    p.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES)
    p.add_argument("--memory-limit", help="DuckDB memory limit, e.g. 8GB")
    p.add_argument("--threads", type=int)
    p.add_argument("--temp-dir", help="DuckDB spill directory (local SSD on VMs)")
    p.add_argument(
        "--key",
        action="append",
        help="only this type-month key, e.g. HKQuantityTypeIdentifierHeartRate/year=2026/month=09",
    )
    p.add_argument("--work-dir", help="local directory to sync gs:// staging into before compacting")
    p.add_argument("--project")
    p.set_defaults(func=cmd_compact)

    p = sub.add_parser("validate", help="check compacted files against the contract and the run report")
    p.add_argument("--compacted", required=True)
    p.add_argument("--report", required=True, help="report.json from work (local or gs://)")
    p.add_argument("--manifest", help="manifest.jsonl the run was planned from; completeness is checked against it")
    p.add_argument("--run-id", required=True)
    p.add_argument("--out", required=True, help="where to write validation.json")
    p.add_argument("--project")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser(
        "promote", help="copy compacted files into the datalake v1/ layout and write snapshot + watermark"
    )
    p.add_argument("--compacted", required=True)
    p.add_argument("--lake", required=True, help="gs://bucket[/prefix] or a local directory")
    p.add_argument("--run-id", required=True)
    p.add_argument("--validation", required=True)
    p.add_argument("--report", required=True)
    p.add_argument("--batch-end", type=_iso_datetime)
    p.add_argument("--project")
    p.set_defaults(func=cmd_promote)

    p = sub.add_parser("plan", help="list a source (gs:// or local dir) and write the immutable manifest")
    p.add_argument("--source", required=True, help="gs://bucket/users or a local directory")
    p.add_argument("--manifest", required=True, help="where to write manifest.jsonl (gs:// or local path)")
    p.add_argument("--uid", action="append")
    p.add_argument("--sample-type", action="append")
    p.add_argument("--batch-start", type=_iso_datetime)
    p.add_argument("--batch-end", type=_iso_datetime)
    p.add_argument("--project")
    p.add_argument("--with-firestore", action="store_true", help="also read users/{uid}/HealthObservations_* per unit")
    p.add_argument("--force", action="store_true", help="overwrite an existing manifest")
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser(
        "work", help="process units from a manifest into a staging location (single worker, no leases yet)"
    )
    p.add_argument("--manifest", required=True)
    p.add_argument("--staging", required=True, help="gs://bucket/prefix or a local directory")
    p.add_argument("--run-id", required=True)
    p.add_argument("--unit-id", action="append")
    p.add_argument("--limit-units", type=int)
    p.add_argument("--participants", help="local participants.json; default is the Firestore lookup")
    p.add_argument("--project")
    _add_key_args(p)
    p.set_defaults(func=cmd_work)

    p = sub.add_parser("inspect", help="DuckDB summary of a staging or v1 prefix on local disk")
    p.add_argument("prefix", type=Path)
    p.add_argument("--show", action="append", help="sample type whose newest rows to print")
    p.add_argument("--limit", type=int, default=5)
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser(
        "bq-load", help="load a staging or v1 prefix (local dir or gs://) into BigQuery, one table per type"
    )
    p.add_argument("prefix")
    p.add_argument("--project", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--append", action="store_true", help="append instead of truncating the tables")
    p.set_defaults(func=cmd_bq_load)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
