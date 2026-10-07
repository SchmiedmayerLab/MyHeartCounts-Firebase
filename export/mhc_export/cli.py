# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from mhc_export import __version__
from mhc_export.config import (
    GroveSettings,
    IdentityConfig,
    check_production,
    load_key,
    load_key_from_secret,
    new_key_hex,
)
from mhc_export.identity.grove_ids import IdentityError
from mhc_export.identity.participants import LocalParticipantLookup
from mhc_export.io.blobstore import BlobStore, LocalBlobStore, RoutedStore, read_uri, store_for, write_uri
from mhc_export.run.compact import DEFAULT_TARGET_BYTES, compact_run
from mhc_export.run.envelope import (
    Eligibility,
    RunEnvelope,
    envelope_digest,
    envelope_uri_for,
    manifest_sha256,
)
from mhc_export.run.inputs import commit_ledger, gather_inputs
from mhc_export.run.inspect import format_summary, sample_rows, summarize
from mhc_export.run.lake import read_current
from mhc_export.run.leases import FirestoreLeaseStore, LocalLeaseStore
from mhc_export.run.manifest import dump_manifest, load_manifest
from mhc_export.run.models import RunReport, UnitResult
from mhc_export.run.promote import promote_run
from mhc_export.run.unit import Deps, process_unit
from mhc_export.run.validate import validate_run
from mhc_export.run.worker import assemble_report, report_from_leases, work_with_leases, worker_context
from mhc_export.sources.bucket import apply_eligibility, plan_units
from mhc_export.sources.users import FileUserFlags, FirestoreUserFlags
from mhc_export.transform.specs import default_coverage, default_registry

log = logging.getLogger("mhc_export")


def _add_key_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--key-hex", help="32+ byte HMAC key as hex (or MHC_EXPORT_KEY_HEX)")
    parser.add_argument("--key-file", type=Path, help="file containing the hex key")
    parser.add_argument(
        "--key-secret", help="Secret Manager version projects/P/secrets/S/versions/V holding the hex key"
    )
    parser.add_argument("--key-id", default="local")
    parser.add_argument("--key-epoch", type=int, default=1)
    parser.add_argument(
        "--accept-epoch", action="append", default=[], help="additional KEY_ID:EPOCH whose identities are accepted"
    )
    parser.add_argument(
        "--allow-test-key", action="store_true", help="accept the Grove public conformance key (tests only)"
    )
    parser.add_argument("--production", action="store_true", help="refuse local keys, the test key and file lookups")


DEFAULT_MAX_UNIT_BYTES = 400_000_000


def _add_shard_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--max-unit-bytes",
        type=int,
        default=DEFAULT_MAX_UNIT_BYTES,
        help="split a user's type into shards of at most this much compressed input (about 3M rows per 400 MB)",
    )


def _add_grove_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--producer-namespace",
        action="append",
        default=[],
        help="KEY_ID:EPOCH under which the app mints its Grove identities (default store:1); repeatable",
    )
    parser.add_argument(
        "--accept-legacy",
        action="store_true",
        help="also read pre-Grove resources (current dev data); refused with --production",
    )


def _parse_namespace(item: str, flag: str) -> tuple[str, int]:
    key_id, sep, epoch = item.rpartition(":")
    if not sep or not key_id or ":" in key_id or not epoch.isdigit() or int(epoch) < 1:
        raise SystemExit(f"{flag} {item!r}: expected KEY_ID:EPOCH with a positive epoch")
    return key_id, int(epoch)


def _grove_settings(args: argparse.Namespace) -> GroveSettings:
    if args.production and args.accept_legacy:
        raise SystemExit("--accept-legacy is not allowed with --production: production reads migrated Grove data only")
    namespaces = tuple(_parse_namespace(n, "--producer-namespace") for n in args.producer_namespace)
    if namespaces:
        return GroveSettings(producer_namespaces=namespaces, accept_legacy=args.accept_legacy)
    return GroveSettings(accept_legacy=args.accept_legacy)


def _identity_config(args: argparse.Namespace, *, project: str | None = None) -> IdentityConfig:
    if args.key_secret:
        key = load_key_from_secret(args.key_secret, key_id=args.key_id, epoch=args.key_epoch, project=project)
        source = "secret-manager"
    else:
        key = load_key(
            key_hex=args.key_hex,
            key_file=args.key_file,
            key_id=args.key_id,
            epoch=args.key_epoch,
            allow_test_key=args.allow_test_key,
        )
        source = "file" if args.key_file else "argument"
    accepted = [_parse_namespace(item, "--accept-epoch") for item in args.accept_epoch]
    try:
        return IdentityConfig(key, key_source=source, accepted_epochs=tuple(accepted))
    except IdentityError as exc:
        raise SystemExit(f"--accept-epoch: {exc}") from exc


def cmd_new_key(_: argparse.Namespace) -> int:
    print(new_key_hex())
    return 0


def cmd_run_local(args: argparse.Namespace) -> int:
    grove = _grove_settings(args)
    identity = _identity_config(args)
    if args.production:
        check_production(identity, participants_source="file")
    source = LocalBlobStore(args.source)
    out_root: Path = args.out
    out_root.mkdir(parents=True, exist_ok=True)
    out_store = LocalBlobStore(out_root)
    registry = default_registry()
    uids = set(args.uid) if args.uid else None
    types = set(args.sample_type) if args.sample_type else None
    # local file times are not upload times, so no creation-time window is applied here
    planned = plan_units(source.list(""), uids=uids, sample_types=types, max_unit_bytes=args.max_unit_bytes)
    planned, eligibility = _apply_eligibility(planned, "file" if args.user_flags else "none", args.user_flags, None)
    units = planned[: args.limit_units] if args.limit_units else planned
    filtered = bool(uids or types or args.limit_units)
    lake_root = out_root / "lake"
    watermark = _read_watermark(str(lake_root))
    run_dir = out_root / "runs" / args.run_id
    manifest_bytes = dump_manifest(units)
    envelope = _make_envelope(
        run_id=args.run_id,
        batch_start=_watermark_end(watermark),
        batch_end=args.batch_end,
        window_applied=False,
        scoped=filtered,
        uids=uids,
        types=types,
        source=str(args.source),
        manifest_bytes=manifest_bytes,
        unit_count=len(units),
        eligibility=eligibility,
    )
    write_uri(str(run_dir / "manifest.jsonl"), manifest_bytes)
    write_uri(str(run_dir / "run.json"), envelope.model_dump_json(indent=1).encode())
    log.info("planned %d units from %s%s", len(units), args.source, " (filtered)" if filtered else "")
    deps = Deps(
        store=RoutedStore(source, out_store),
        registry=registry,
        identity=identity,
        participants=LocalParticipantLookup(out_root / "private" / "participants.json"),
        staging_prefix=f"staging/{args.run_id}",
        run_id=args.run_id,
        tolerate_unreadable=args.tolerate_fatal > 0,
        max_unit_rows=args.max_unit_rows,
        grove=grove,
    )
    phases = set(args.phases.split(","))
    report_path = run_dir / "report.json"
    if "work" in phases:
        report, unit_results = _process_all(
            units,
            deps,
            args.run_id,
            planned_units=len(units),
            filtered=filtered,
            tolerated_fatal=args.tolerate_fatal,
            envelope_sha=envelope_digest(envelope),
        )
        payload = json.dumps({"report": report.model_dump(), "units": unit_results}, indent=1, default=str)
        write_uri(str(report_path), payload.encode())
        print(_summary_line(report))
        print(f"report: {report_path}")
        if report.units_failed:
            return 1
    compacted_root = out_root / "compacted" / args.run_id
    lake_root.mkdir(exist_ok=True)
    lake = LocalBlobStore(lake_root)
    inputs = None
    if phases & {"compact", "validate"}:
        inputs = gather_inputs(
            lake=lake, lake_prefix="", state=out_store, state_prefix="", run_id=args.run_id, work_dir=out_root / "work"
        )
    if "compact" in phases:
        assert inputs is not None
        results = compact_run(
            inputs, compacted_root, run_id=args.run_id, target_bytes=args.target_bytes, registry=registry
        )
        print(f"compacted {len(results)} partitions into {sum(len(r.files) for r in results)} files")
    validation_path = run_dir / "validation.json"
    if "validate" in phases:
        assert inputs is not None
        run_report = json.loads(report_path.read_text())
        manifest_units = load_manifest(manifest_bytes)
        validation = validate_run(
            compacted_root,
            run_report,
            run_id=args.run_id,
            uids={u.uid for u in manifest_units},
            registry=registry,
            manifest=manifest_units,
            envelope=envelope,
            manifest_digest=manifest_sha256(manifest_bytes),
            inputs=inputs,
        )
        validation_path.write_text(validation.model_dump_json(indent=1))
        _print_validation(validation)
        if not validation.ok:
            return 2
    if "promote" in phases:
        commit_ledger(out_store, "", args.run_id)
        result = promote_run(
            compacted_root,
            lake,
            "",
            run_id=args.run_id,
            envelope=envelope,
            validation=json.loads(validation_path.read_text()),
            run_report=json.loads(report_path.read_text()),
        )
        print(_promote_line(result, str(lake_root)))
    return 0


def _print_validation(validation) -> None:
    status = "PASSED" if validation.ok else "FAILED"
    print(
        f"validation {status}: {len(validation.checks)} checks, {validation.rows_total} rows, {validation.seconds:.1f}s"
    )
    for check in validation.failures():
        print(f"  FAIL {check.name} {check.sample_type or ''}: {check.detail}")


def cmd_compact(args: argparse.Namespace) -> int:
    inputs = _gather(args)
    results = compact_run(
        inputs,
        Path(args.out),
        run_id=args.run_id,
        target_bytes=args.target_bytes,
        memory_limit=args.memory_limit,
        threads=args.threads,
        temp_dir=Path(args.temp_dir) if args.temp_dir else None,
    )
    total_files = sum(len(r.files) for r in results)
    total_bytes = sum(r.bytes for r in results)
    replaced = sum(1 for r in results if r.committed_rows)
    print(
        f"compacted {len(results)} partitions ({replaced} replacing committed data), "
        f"{sum(r.rows for r in results)} rows -> {total_files} files, {total_bytes / 1e6:.1f} MB"
    )
    return 0


def _store(uri: str, project: str | None) -> tuple[BlobStore, str]:
    """(store, prefix): gs:// locations keep their full URI as prefix; local directories become the store root."""
    if uri.startswith("gs://"):
        return store_for(uri, project=project), uri.rstrip("/")
    Path(uri).mkdir(parents=True, exist_ok=True)
    return LocalBlobStore(uri), ""


def _gather(args: argparse.Namespace):
    lake, lake_prefix = _store(args.lake, args.project)
    state, state_prefix = _store(args.state, args.project)
    return gather_inputs(
        lake=lake,
        lake_prefix=lake_prefix,
        state=state,
        state_prefix=state_prefix,
        run_id=args.run_id,
        work_dir=Path(args.work_dir),
    )


def cmd_validate(args: argparse.Namespace) -> int:
    run_report = json.loads(read_uri(args.report, project=args.project))
    manifest_bytes = read_uri(args.manifest, project=args.project)
    manifest_units = load_manifest(manifest_bytes)
    envelope = _load_envelope(args.envelope or envelope_uri_for(args.manifest), args.project)
    uids = {u.uid for u in manifest_units} | {unit_id.split(":", 1)[0] for unit_id in run_report.get("units", {})}
    validation = validate_run(
        Path(args.compacted),
        run_report,
        run_id=args.run_id,
        uids=uids,
        manifest=manifest_units,
        envelope=envelope,
        manifest_digest=manifest_sha256(manifest_bytes),
        inputs=_gather(args),
    )
    write_uri(args.out, validation.model_dump_json(indent=1).encode(), project=args.project)
    _print_validation(validation)
    return 0 if validation.ok else 2


def cmd_promote(args: argparse.Namespace) -> int:
    for private in (args.state, args.report, args.validation, args.envelope):
        if _same_storage(private, args.lake):
            raise SystemExit(
                f"--lake {args.lake} overlaps the private state at {private}: "
                "staging and raw reports carry Firebase uids"
            )
    validation = json.loads(read_uri(args.validation, project=args.project))
    run_report = json.loads(read_uri(args.report, project=args.project))
    envelope = _load_envelope(args.envelope, args.project)
    if args.lake.startswith("gs://"):
        lake, prefix = store_for(args.lake, project=args.project), args.lake
    else:
        lake, prefix = LocalBlobStore(args.lake), ""
    state, state_prefix = _store(args.state, args.project)
    commit_ledger(state, state_prefix, args.run_id)
    result = promote_run(
        Path(args.compacted),
        lake,
        prefix,
        run_id=args.run_id,
        envelope=envelope,
        validation=validation,
        run_report=run_report,
        production=args.production,
    )
    print(_promote_line(result, args.lake))
    return 0


def _promote_line(result, lake: str) -> str:
    if result.already_committed:
        return f"run {result.run_id} is already the committed dataset of {lake}"
    return (
        f"committed {result.run_id} to {lake}: {result.copied} files uploaded ({result.skipped} already present), "
        f"{result.replaced_partitions} partitions replaced; dataset {result.dataset_files} files, "
        f"{result.dataset_rows} rows ({result.dataset_uri})"
    )


def _process_all(
    units: list,
    deps: Deps,
    run_id: str,
    *,
    planned_units: int | None = None,
    filtered: bool = False,
    tolerated_fatal: int = 0,
    participants_source: str = "file",
    envelope_sha: str = "",
) -> tuple[RunReport, dict[str, dict]]:
    started = time.monotonic()
    outcomes: dict[str, UnitResult | str] = {}
    for i, unit in enumerate(units, 1):
        try:
            result = process_unit(unit, deps)
        except Exception as exc:  # noqa: BLE001
            log.exception("unit %s failed", unit.unit_id)
            outcomes[unit.unit_id] = str(exc)
            continue
        outcomes[unit.unit_id] = result
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
    context = worker_context(
        deps, envelope_sha=envelope_sha, tolerated_fatal=tolerated_fatal, participants_source=participants_source
    )
    return assemble_report(
        run_id,
        units,
        outcomes,
        context,
        planned_units=planned_units,
        filtered=filtered,
        seconds=time.monotonic() - started,
    )


def _summary_line(report: RunReport) -> str:
    return (
        f"run {report.run_id}: {report.units_done} units done, {report.units_failed} failed, "
        f"{report.rows_out} rows, {len(report.totals.parts)} parts, {report.seconds:.0f}s"
    )


def cmd_plan(args: argparse.Namespace) -> int:
    if args.lake and args.batch_start:
        raise SystemExit("--batch-start is derived from --lake; give one of them")
    if args.batch_end and args.batch_end > datetime.now(UTC):
        raise SystemExit("--batch-end is in the future: uploads created after this listing would be skipped for good")
    batch_start = args.batch_start
    if args.lake:
        batch_start = _watermark_end(_read_watermark(args.lake, args.project))
    store = store_for(args.source, project=args.project)
    uids = set(args.uid) if args.uid else None
    types = set(args.sample_type) if args.sample_type else None
    planned = plan_units(
        store.list(args.source),
        uids=uids,
        sample_types=types,
        batch_start=batch_start,
        batch_end=args.batch_end,
        max_unit_bytes=args.max_unit_bytes,
    )
    units, eligibility = _apply_eligibility(planned, args.eligibility, args.user_flags, args.project)
    listed_users = len({u.uid for u in planned})
    if listed_users and eligibility.excluded_users.get("no_account", 0) == listed_users:
        raise SystemExit(
            f"none of the {listed_users} listed users has an account document; check --project and the "
            "permissions on the users collection"
        )
    manifest_bytes = dump_manifest(units)
    envelope = _make_envelope(
        run_id=args.run_id,
        batch_start=batch_start,
        batch_end=args.batch_end,
        window_applied=args.batch_end is not None,
        scoped=bool(uids or types),
        uids=uids,
        types=types,
        source=args.source,
        manifest_bytes=manifest_bytes,
        unit_count=len(units),
        eligibility=eligibility,
    )
    write_uri(args.manifest, manifest_bytes, overwrite=args.force, project=args.project)
    envelope_uri = envelope_uri_for(args.manifest)
    write_uri(envelope_uri, envelope.model_dump_json(indent=1).encode(), overwrite=args.force, project=args.project)
    total_bytes = sum(u.expected_bytes for u in units)
    excluded = ", ".join(f"{n} {reason}" for reason, n in eligibility.excluded_users.items()) or "none"
    print(
        f"planned {len(units)} units, {sum(len(u.objects) for u in units)} objects, {total_bytes / 1e9:.2f} GB "
        f"for [{batch_start.isoformat() if batch_start else 'start'}, "
        f"{args.batch_end.isoformat() if args.batch_end else 'open'}); excluded users: {excluded}"
    )
    print(f"manifest: {args.manifest}\nenvelope: {envelope_uri}")
    return 0


def _version_drift(envelope: RunEnvelope) -> str | None:
    running = {
        "package_version": __version__,
        "registry_sha256": default_registry().digest,
        "coverage_sha256": default_coverage().digest,
    }
    planned = {k: getattr(envelope, k) for k in running}
    drift = [f"{k} {planned[k] or 'unset'} != {running[k]}" for k in running if planned[k] != running[k]]
    return "; ".join(drift) or None


def _apply_eligibility(units: list, mode: str, user_flags: str | None, project: str | None) -> tuple[list, Eligibility]:
    if mode == "none":
        return units, Eligibility(source="unchecked")
    if mode == "file":
        if not user_flags:
            raise SystemExit("--eligibility file needs --user-flags")
        flags_source = FileUserFlags(Path(user_flags))
    else:
        flags_source = FirestoreUserFlags(project=project)
    flags = flags_source.flags_for({u.uid for u in units})
    kept, excluded_users, excluded_units = apply_eligibility(units, flags)
    return kept, Eligibility(source=flags_source.name, excluded_users=excluded_users, excluded_units=excluded_units)


def _make_envelope(
    *,
    run_id: str,
    batch_start: datetime | None,
    batch_end: datetime | None,
    window_applied: bool,
    scoped: bool,
    uids: set[str] | None,
    types: set[str] | None,
    source: str,
    manifest_bytes: bytes,
    unit_count: int,
    eligibility: Eligibility,
) -> RunEnvelope:
    registry = default_registry()
    return RunEnvelope(
        run_id=run_id,
        batch_start=batch_start,
        batch_end=batch_end,
        window_applied=window_applied,
        scoped=scoped,
        scope_uid_count=len(uids) if uids else None,
        scope_sample_types=sorted(types) if types else None,
        source=source,
        manifest_sha256=manifest_sha256(manifest_bytes),
        unit_count=unit_count,
        eligibility=eligibility,
        grove_version=registry.grove_version,
        registry_commit=str(registry.generated_from.get("commit", "")),
        package_version=__version__,
        created_at=datetime.now(tz=UTC),
        registry_sha256=registry.digest,
        coverage_sha256=default_coverage().digest,
    )


def _load_envelope(uri: str, project: str | None) -> RunEnvelope:
    try:
        return RunEnvelope.model_validate_json(read_uri(uri, project=project))
    except FileNotFoundError as exc:
        raise SystemExit(f"run envelope {uri} not found; plan writes it next to the manifest") from exc


def _read_watermark(lake: str, project: str | None = None) -> dict | None:
    """The committed lake pointer as a plain dict (run_id, batch_end, ...), or None for an empty lake."""
    store, prefix = _store(lake, project) if lake.startswith("gs://") or Path(lake).exists() else (None, "")
    if store is None:
        return None
    pointer, _ = read_current(store, prefix)
    return pointer.model_dump(mode="json") if pointer else None


def _watermark_end(watermark: dict | None) -> datetime | None:
    if not watermark or not watermark.get("batch_end"):
        return None
    return datetime.fromisoformat(watermark["batch_end"])


def cmd_work(args: argparse.Namespace) -> int:
    grove = _grove_settings(args)
    identity = _identity_config(args, project=args.project)
    participants_source = "file" if args.participants else "firestore"
    if args.production:
        check_production(identity, participants_source=participants_source)
    manifest_bytes = read_uri(args.manifest, project=args.project)
    envelope = _load_envelope(args.envelope or envelope_uri_for(args.manifest), args.project)
    if envelope.run_id != args.run_id:
        raise SystemExit(f"the envelope belongs to run {envelope.run_id}, not {args.run_id}")
    if envelope.manifest_sha256 != manifest_sha256(manifest_bytes):
        raise SystemExit("the manifest changed after planning")
    if drift := _version_drift(envelope):
        raise SystemExit(f"this worker differs from the plan: {drift}")
    manifest_units = load_manifest(manifest_bytes)
    units = manifest_units
    if args.unit_id:
        wanted = set(args.unit_id)
        units = [u for u in units if u.unit_id in wanted]
    if args.limit_units:
        units = units[: args.limit_units]
    filtered = bool(args.unit_id or args.limit_units)
    source_root = units[0].objects[0].uri if units and units[0].objects else args.state
    read_store = store_for(source_root, project=args.project)
    if args.state.startswith("gs://"):
        write_store = store_for(args.state, project=args.project)
        staging_prefix = f"{args.state.rstrip('/')}/staging/{args.run_id}"
    else:
        write_store = LocalBlobStore(args.state)
        staging_prefix = f"staging/{args.run_id}"
    participants = LocalParticipantLookup(Path(args.participants)) if args.participants else None
    if participants is None:
        from mhc_export.identity.participants import FirestoreParticipantLookup

        participants = FirestoreParticipantLookup(project=args.project)
    deps = Deps(
        store=RoutedStore(read_store, write_store),
        registry=default_registry(),
        identity=identity,
        participants=participants,
        staging_prefix=staging_prefix,
        run_id=args.run_id,
        tolerate_unreadable=args.tolerate_fatal > 0,
        max_unit_rows=args.max_unit_rows,
        grove=grove,
    )
    if args.leases:
        if filtered:
            raise SystemExit("--unit-id and --limit-units are not available with --leases")
        store = _lease_store(args.leases, args.run_id, args.project)
        store.seed([u.unit_id for u in manifest_units])
        context = worker_context(
            deps,
            envelope_sha=envelope_digest(envelope),
            tolerated_fatal=args.tolerate_fatal,
            participants_source=participants_source,
        )
        owner = args.worker_id or f"{socket.gethostname()}-{os.getpid()}"
        done, failed = work_with_leases(
            {u.unit_id: u for u in manifest_units},
            deps,
            store,
            owner=owner,
            context=context,
            ttl=timedelta(seconds=args.lease_seconds),
            max_attempts=args.max_attempts,
        )
        print(f"worker {owner}: {done} units completed, {failed} attempts failed; no claimable units left")
        return 0
    log.info("working %d units from %s into %s", len(units), args.manifest, staging_prefix)
    report, unit_results = _process_all(
        units,
        deps,
        args.run_id,
        planned_units=len(manifest_units),
        filtered=filtered,
        tolerated_fatal=args.tolerate_fatal,
        participants_source=participants_source,
        envelope_sha=envelope_digest(envelope),
    )
    if args.state.startswith("gs://"):
        report_uri = f"{args.state.rstrip('/')}/runs/{args.run_id}/report.json"
    else:
        report_uri = str(Path(args.state) / "runs" / args.run_id / "report.json")
    write_uri(
        report_uri,
        json.dumps({"report": report.model_dump(), "units": unit_results}, indent=1, default=str).encode(),
        project=args.project,
    )
    print(_summary_line(report))
    print(f"report: {report_uri}")
    return 1 if report.units_failed else 0


def cmd_report(args: argparse.Namespace) -> int:
    manifest_units = load_manifest(read_uri(args.manifest, project=args.project))
    store = _lease_store(args.leases, args.run_id, args.project)
    report, unit_results = report_from_leases(args.run_id, manifest_units, store, planned_units=len(manifest_units))
    if args.state.startswith("gs://"):
        report_uri = f"{args.state.rstrip('/')}/runs/{args.run_id}/report.json"
    else:
        report_uri = str(Path(args.state) / "runs" / args.run_id / "report.json")
    payload = json.dumps({"report": report.model_dump(), "units": unit_results}, indent=1, default=str)
    write_uri(report_uri, payload.encode(), project=args.project)
    pending = report.units_total - report.units_done - report.units_failed
    print(_summary_line(report) + (f", {pending} not finished" if pending else ""))
    print(f"report: {report_uri}")
    return 0 if pending == 0 and report.units_failed == 0 else 1


def _lease_store(spec: str, run_id: str, project: str | None):
    if spec == "firestore":
        return FirestoreLeaseStore(run_id, project=project)
    if spec.startswith("local:"):
        return LocalLeaseStore(Path(spec[len("local:") :]) / run_id)
    raise SystemExit(f"--leases {spec!r}: expected 'firestore' or 'local:<directory>'")


def cmd_inspect(args: argparse.Namespace) -> int:
    print(format_summary(summarize(args.prefix)))
    if args.show:
        for sample_type in args.show:
            print(f"\n{sample_type}, newest rows:")
            print(sample_rows(args.prefix, sample_type, args.limit))
    return 0


def cmd_bq_load(args: argparse.Namespace) -> int:
    from mhc_export.run.bigquery import load_committed

    lake, prefix = _store(args.lake, args.project)
    nonce = datetime.now(UTC).isoformat() if args.full else ""
    record = load_committed(lake, prefix, args.project, args.dataset, full=args.full, nonce=nonce)
    print(
        f"loaded {len(record['loads'])} partitions and deleted {len(record['deletes'])} for run {record['run_id']} "
        f"into {args.project}.{args.dataset}"
    )
    return 0


def _same_storage(private: str, lake: str) -> bool:
    """gs:// locations collide on the bucket; local paths collide when one contains the other."""
    if private.startswith("gs://") or lake.startswith("gs://"):
        bucket = lambda uri: uri[5:].split("/", 1)[0] if uri.startswith("gs://") else None  # noqa: E731
        return bucket(private) is not None and bucket(private) == bucket(lake)
    a, b = Path(private).resolve(), Path(lake).resolve()
    if a.is_file() or a.suffix:
        a = a.parent
    return a == b or a in b.parents or b in a.parents


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
    p.add_argument("--tolerate-fatal", type=int, default=0, help="continue past this many unreadable inputs")
    p.add_argument("--max-unit-rows", type=int, default=5_000_000, help="fail a unit above this many rows")
    p.add_argument("--user-flags", help="JSON {uid: user document fields}; without it eligibility is unchecked")
    _add_shard_arg(p)
    _add_key_args(p)
    _add_grove_args(p)
    p.set_defaults(func=cmd_run_local)

    p = sub.add_parser("compact", help="rebuild every partition the run changes into files of about --target-bytes")
    p.add_argument("--state", required=True, help="private state location the run was worked into")
    p.add_argument("--lake", required=True, help="lake whose committed dataset the run builds on")
    p.add_argument("--run-id", required=True)
    p.add_argument("--out", required=True, help="local directory for the rebuilt partitions")
    p.add_argument("--work-dir", required=True, help="local directory for inputs fetched from gs://")
    p.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES)
    p.add_argument("--memory-limit", help="DuckDB memory limit, e.g. 8GB")
    p.add_argument("--threads", type=int)
    p.add_argument("--temp-dir", help="DuckDB spill directory (local SSD on VMs)")
    p.add_argument("--project")
    p.set_defaults(func=cmd_compact)

    p = sub.add_parser("validate", help="check compacted files against the contract and the run report")
    p.add_argument("--compacted", required=True)
    p.add_argument("--report", required=True, help="report.json from work (local or gs://)")
    p.add_argument("--manifest", required=True, help="manifest.jsonl the run was planned from")
    p.add_argument("--envelope", help="run.json; defaults to the file next to the manifest")
    p.add_argument("--run-id", required=True)
    p.add_argument("--out", required=True, help="where to write validation.json")
    p.add_argument("--state", required=True, help="private state location the run was worked into")
    p.add_argument("--lake", required=True, help="lake whose committed dataset the run builds on")
    p.add_argument("--work-dir", required=True, help="local directory for inputs fetched from gs://")
    p.add_argument("--project")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("promote", help="publish the rebuilt partitions as the lake's next dataset version, atomically")
    p.add_argument("--compacted", required=True)
    p.add_argument("--lake", required=True, help="gs://bucket[/prefix] or a local directory")
    p.add_argument("--run-id", required=True)
    p.add_argument("--validation", required=True)
    p.add_argument("--report", required=True)
    p.add_argument("--envelope", required=True, help="run.json written by plan; the batch bounds come from it")
    p.add_argument("--state", required=True, help="private state location; promote refuses a lake that overlaps it")
    p.add_argument(
        "--production",
        action="store_true",
        help="also require the recorded run to be a production run: Secret Manager key, Firestore participants "
        "and eligibility, no legacy input, a whole source bucket, at least one unit",
    )
    p.add_argument("--project")
    p.set_defaults(func=cmd_promote)

    p = sub.add_parser("plan", help="list a source, apply eligibility and write the manifest and run envelope")
    p.add_argument("--source", required=True, help="gs://bucket/prefix or a local directory")
    p.add_argument(
        "--manifest", required=True, help="where to write manifest.jsonl (gs:// or local); run.json goes next to it"
    )
    p.add_argument("--run-id", required=True)
    p.add_argument("--uid", action="append", help="scope to a participant; scoped runs never promote")
    p.add_argument("--sample-type", action="append", help="scope to a type; scoped runs never promote")
    p.add_argument("--lake", help="derive the batch start from this lake's watermark")
    p.add_argument("--batch-start", type=_iso_datetime, help="explicit batch start, only without --lake")
    p.add_argument("--batch-end", type=_iso_datetime, help="exclusive upper bound on object creation time")
    p.add_argument("--eligibility", choices=["firestore", "file", "none"], default="firestore")
    p.add_argument("--user-flags", help="JSON {uid: user document fields} for --eligibility file")
    p.add_argument("--project")
    p.add_argument("--force", action="store_true", help="overwrite an existing manifest and envelope")
    _add_shard_arg(p)
    p.set_defaults(func=cmd_plan)

    p = sub.add_parser(
        "work", help="process units from a manifest into a staging location (single worker, no leases yet)"
    )
    p.add_argument("--manifest", required=True)
    p.add_argument("--envelope", help="run.json; defaults to the file next to the manifest")
    p.add_argument(
        "--state",
        required=True,
        help="private state location (gs://bucket/prefix or a local directory) for staging and reports",
    )
    p.add_argument("--run-id", required=True)
    p.add_argument("--unit-id", action="append")
    p.add_argument("--limit-units", type=int)
    p.add_argument("--participants", help="local participants.json; default is the Firestore lookup")
    p.add_argument("--project")
    p.add_argument(
        "--tolerate-fatal",
        type=int,
        default=0,
        help="continue past this many unreadable inputs; recorded in the report",
    )
    p.add_argument("--max-unit-rows", type=int, default=5_000_000, help="fail a unit above this many rows")
    p.add_argument("--leases", help="share the manifest with other workers: 'firestore' or 'local:<directory>'")
    p.add_argument("--worker-id", help="lease owner name; defaults to host and process id")
    p.add_argument("--lease-seconds", type=int, default=1800, help="lease time to live; renewed every third of it")
    p.add_argument("--max-attempts", type=int, default=3, help="attempts per unit before it fails for good")
    _add_key_args(p)
    _add_grove_args(p)
    p.set_defaults(func=cmd_work)

    p = sub.add_parser("report", help="assemble the run report from the lease store once workers are finished")
    p.add_argument("--manifest", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--leases", required=True, help="'firestore' or 'local:<directory>'")
    p.add_argument("--project")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("inspect", help="DuckDB summary of a staging or v1 prefix on local disk")
    p.add_argument("prefix", type=Path)
    p.add_argument("--show", action="append", help="sample type whose newest rows to print")
    p.add_argument("--limit", type=int, default=5)
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("bq-load", help="bring BigQuery to the lake's committed dataset, one table per sample type")
    p.add_argument("--lake", required=True, help="gs:// lake with a committed dataset")
    p.add_argument("--project", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument(
        "--full",
        action="store_true",
        help="reload every partition, not only those that differ from what the destination holds",
    )
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
