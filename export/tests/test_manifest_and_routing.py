# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from mhc_export.cli import main
from mhc_export.io.blobstore import BlobExistsError, LocalBlobStore, RoutedStore
from mhc_export.run.envelope import RunEnvelope, envelope_digest
from mhc_export.run.manifest import dump_manifest, load_manifest
from mhc_export.run.promote import PromoteConflict
from mhc_export.sources.bucket import plan_units
from tests.test_unit_e2e import TEST_KEY_HEX, UID, build_source

HR = "HKQuantityTypeIdentifierHeartRate"


def test_manifest_roundtrip(tmp_path: Path) -> None:
    build_source(tmp_path)
    units = plan_units(LocalBlobStore(tmp_path).list(""))
    back = load_manifest(dump_manifest(units))
    assert back == units and len(back) == 3


def test_routed_store(tmp_path: Path) -> None:
    a = LocalBlobStore(tmp_path / "a")
    b = LocalBlobStore(tmp_path / "b")
    a.write("x", b"1", overwrite=True)
    routed = RoutedStore(a, b)
    assert routed.read("x") == b"1"
    routed.write("y", b"2", overwrite=False)
    assert b.read("y") == b"2" and not a.exists("y") and routed.exists("y")


def _write_flags(path: Path, docs: dict) -> Path:
    path.write_text(json.dumps(docs))
    return path


def test_plan_then_work_locally(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    manifest = tmp_path / "state" / "manifest.jsonl"
    flags = _write_flags(tmp_path / "flags.json", {UID: {"hasWithdrawnFromStudy": False}})
    plan = ["plan", "--source", str(src), "--manifest", str(manifest), "--run-id", "r9", "--sample-type", HR]
    assert main([*plan, "--eligibility", "file", "--user-flags", str(flags)]) == 0
    units = load_manifest(manifest.read_bytes())
    assert [u.unit_id for u in units] == [f"{UID}:{HR}"]
    envelope = RunEnvelope.model_validate_json((tmp_path / "state" / "run.json").read_text())
    assert envelope.run_id == "r9" and envelope.scoped and envelope.scope_sample_types == [HR]
    assert envelope.eligibility.source == "file" and envelope.unit_count == 1 and not envelope.window_applied
    staging = tmp_path / "staging"
    work = [
        "work",
        "--manifest",
        str(manifest),
        "--state",
        str(staging),
        "--participants",
        str(tmp_path / "p.json"),
        "--key-hex",
        TEST_KEY_HEX,
        "--allow-test-key",
        "--accept-legacy",
    ]
    with pytest.raises(SystemExit, match="belongs to run r9"):
        main([*work, "--run-id", "other"])
    assert main([*work, "--run-id", "r9"]) == 0
    report = json.loads((staging / "runs" / "r9" / "report.json").read_text())
    assert report["report"]["rows_out"] == 5 and report["report"]["envelope_sha256"] == envelope_digest(envelope)
    assert (staging / "staging" / "r9" / HR).is_dir()
    # a manifest edited after planning is refused
    manifest.write_bytes(manifest.read_bytes() + b"\n")
    with pytest.raises(SystemExit, match="changed after planning"):
        main([*work, "--run-id", "r9"])
    # planning twice without --force never overwrites
    with pytest.raises(BlobExistsError):
        main([*plan, "--eligibility", "none"])


def test_eligibility_excludes_withdrawn_deleted_and_missing_accounts(tmp_path: Path) -> None:
    src = tmp_path / "src"
    for uid in ("u-ok", "u-withdrawn", "u-deleting", "u-gone"):
        build_source(src, uid=uid)
    flags = _write_flags(
        tmp_path / "flags.json",
        {"u-ok": {}, "u-withdrawn": {"hasWithdrawnFromStudy": True}, "u-deleting": {"toBeDeleted": True}},
    )
    manifest = tmp_path / "state" / "manifest.jsonl"
    assert (
        main(
            [
                "plan",
                "--source",
                str(src),
                "--manifest",
                str(manifest),
                "--run-id",
                "r1",
                "--eligibility",
                "file",
                "--user-flags",
                str(flags),
            ]
        )
        == 0
    )
    assert {u.uid for u in load_manifest(manifest.read_bytes())} == {"u-ok"}
    envelope = RunEnvelope.model_validate_json((tmp_path / "state" / "run.json").read_text())
    assert envelope.eligibility.excluded_users == {"deletion_requested": 1, "no_account": 1, "withdrawn": 1}
    assert envelope.eligibility.excluded_units == 9
    # run-local applies the same rule
    out = tmp_path / "out"
    rc = main(
        [
            "run-local",
            "--source",
            str(src),
            "--out",
            str(out),
            "--run-id",
            "r1",
            "--key-hex",
            TEST_KEY_HEX,
            "--allow-test-key",
            "--accept-legacy",
            "--user-flags",
            str(flags),
            "--phases",
            "work",
        ]
    )
    assert rc == 0
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    assert {u.split(":")[0] for u in report["units"]} == {"u-ok"}


def test_full_cli_chain_enforces_contiguous_windows(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    uploaded = datetime(2025, 6, 1, tzinfo=UTC).timestamp()
    for path in src.rglob("*"):
        os.utime(path, (uploaded, uploaded))
    flags = _write_flags(tmp_path / "flags.json", {UID: {}})
    state = tmp_path / "state"
    lake = tmp_path / "lake"
    key = ["--key-hex", TEST_KEY_HEX, "--allow-test-key", "--accept-legacy", "--participants", str(tmp_path / "p.json")]

    def run(run_id: str, *window: str) -> int:
        manifest = state / "runs" / run_id / "manifest.jsonl"
        common = ["--run-id", run_id]
        assert (
            main(
                [
                    "plan",
                    "--source",
                    str(src),
                    "--manifest",
                    str(manifest),
                    *common,
                    "--eligibility",
                    "file",
                    "--user-flags",
                    str(flags),
                    *window,
                ]
            )
            == 0
        )
        assert main(["work", "--manifest", str(manifest), "--state", str(state), *common, *key]) == 0
        compacted = tmp_path / "compacted" / run_id
        where = ["--state", str(state), "--lake", str(lake), "--work-dir", str(tmp_path / "work")]
        assert main(["compact", "--out", str(compacted), *where, *common]) == 0
        validation = state / "runs" / run_id / "validation.json"
        report = state / "runs" / run_id / "report.json"
        assert (
            main(
                [
                    "validate",
                    "--compacted",
                    str(compacted),
                    "--report",
                    str(report),
                    "--manifest",
                    str(manifest),
                    "--out",
                    str(validation),
                    *where,
                    *common,
                ]
            )
            == 0
        )
        return main(
            [
                "promote",
                "--compacted",
                str(compacted),
                "--lake",
                str(lake),
                "--state",
                str(state),
                "--validation",
                str(validation),
                "--report",
                str(report),
                "--envelope",
                str(state / "runs" / run_id / "run.json"),
                *common,
            ]
        )

    assert run("r1", "--batch-end", "2025-07-01T00:00:00Z") == 0
    assert json.loads((lake / "_current.json").read_text())["batch_end"].startswith("2025-07-01")
    # the next run derives its start from the lake and promotes
    assert run("r2", "--lake", str(lake), "--batch-end", "2025-08-01T00:00:00Z") == 0
    assert json.loads((lake / "_current.json").read_text())["run_id"] == "r2"
    # a run that leaves a gap is refused
    with pytest.raises(PromoteConflict, match="contiguous"):
        run("r3", "--batch-start", "2025-09-01T00:00:00Z", "--batch-end", "2025-10-01T00:00:00Z")
    # a window that ends in the future is refused at plan time
    with pytest.raises(SystemExit, match="future"):
        run("r4", "--lake", str(lake), "--batch-end", "2999-01-01T00:00:00Z")
