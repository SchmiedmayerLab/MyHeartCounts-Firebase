# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
from pathlib import Path

from mhc_export.cli import main
from mhc_export.io.blobstore import LocalBlobStore, RoutedStore
from mhc_export.run.manifest import dump_manifest, load_manifest
from mhc_export.sources.bucket import plan_units
from tests.test_unit_e2e import TEST_KEY_HEX, UID, build_source


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


def test_plan_then_work_locally(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    manifest = tmp_path / "state" / "manifest.jsonl"
    assert (
        main(
            [
                "plan",
                "--source",
                str(src),
                "--manifest",
                str(manifest),
                "--sample-type",
                "HKQuantityTypeIdentifierHeartRate",
            ]
        )
        == 0
    )
    units = load_manifest(manifest.read_bytes())
    assert [u.unit_id for u in units] == [f"{UID}:HKQuantityTypeIdentifierHeartRate"]
    staging = tmp_path / "staging"
    rc = main(
        [
            "work",
            "--manifest",
            str(manifest),
            "--staging",
            str(staging),
            "--run-id",
            "r9",
            "--participants",
            str(tmp_path / "participants.json"),
            "--key-hex",
            TEST_KEY_HEX,
            "--allow-test-key",
        ]
    )
    assert rc == 0
    report = json.loads((staging / "runs" / "r9" / "report.json").read_text())
    assert report["report"]["rows_out"] == 5
    assert (staging / "staging" / "r9" / "HKQuantityTypeIdentifierHeartRate").is_dir()
