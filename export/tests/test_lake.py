# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Multi-run behaviour of the lake: partition replacement, the retraction ledger, and the atomic pointer."""

import json
from pathlib import Path

import duckdb
import orjson
import pytest
import zstandard

from mhc_export.cli import main
from mhc_export.io.blobstore import BlobConflict, LocalBlobStore
from mhc_export.run.envelope import RunEnvelope
from mhc_export.run.lake import read_committed
from mhc_export.run.promote import PromoteConflict, promote_run
from tests.conftest import pre_grove_heart_rate
from tests.test_unit_e2e import TEST_KEY_HEX

UID = "user-lake"
HR = "HKQuantityTypeIdentifierHeartRate"


def _zstd(data: bytes) -> bytes:
    return zstandard.ZstdCompressor(write_content_size=False).compress(data)


def _uuid(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-000000000000"


def _sample(n: int, day: int, month: int = 12, year: int = 2025, value: int = 60) -> dict:
    res = pre_grove_heart_rate(
        id=_uuid(n), identifier=[], effectiveDateTime=f"{year}-{month:02d}-{day:02d}T10:00:00+01:00"
    )
    res["valueQuantity"]["value"] = value
    return res


def _source(
    root: Path, *, samples: list[dict] | None = None, deletions: list[int] | None = None, name: str = "A"
) -> Path:
    base = root / "users" / UID
    if samples:
        (base / "liveHealthSamples").mkdir(parents=True, exist_ok=True)
        (base / "liveHealthSamples" / f"{HR}_{name}.json.zstd").write_bytes(_zstd(orjson.dumps(samples)))
    if deletions:
        (base / "healthDeletions").mkdir(parents=True, exist_ok=True)
        rows = "".join(f"{HR},{_uuid(n)},1787567716.438\r\n" for n in deletions)
        (base / "healthDeletions" / f"{HR}_{name}.csv.zstd").write_bytes(
            _zstd(("sampleType,sampleId,timestamp\r\n" + rows).encode())
        )
    return root


def _run(src: Path, out: Path, run_id: str) -> int:
    return main(
        [
            "run-local",
            "--source",
            str(src),
            "--out",
            str(out),
            "--run-id",
            run_id,
            "--key-hex",
            TEST_KEY_HEX,
            "--allow-test-key",
        ]
    )


def _lake_rows(out: Path) -> list[tuple]:
    lake = out / "lake"
    pointer, _, entries = read_committed(LocalBlobStore(lake), "")
    if not entries:
        return []
    paths = "[" + ", ".join(f"'{lake / e.path}'" for e in entries) + "]"
    return (
        duckdb.connect()
        .execute(
            f"select sample_id, value, strftime(effective_start, '%Y-%m') from read_parquet({paths}) order by 3, 2"
        )
        .fetchall()
    )


def test_reupload_in_a_later_run_replaces_the_partition_without_duplicates(tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert _run(_source(tmp_path / "s1", samples=[_sample(1, 3), _sample(2, 4)]), out, "r1") == 0
    first = _lake_rows(out)
    assert len(first) == 2
    # r2 re-sends both samples (e.g. after a reinstall) and adds one new
    assert (
        _run(_source(tmp_path / "s2", samples=[_sample(1, 3), _sample(2, 4), _sample(3, 5)], name="B"), out, "r2") == 0
    )
    rows = _lake_rows(out)
    assert len(rows) == 3 and len({r[0] for r in rows}) == 3
    pointer = json.loads((out / "lake" / "_current.json").read_text())
    dataset = [json.loads(line) for line in (out / "lake" / pointer["dataset"]).read_text().splitlines()]
    assert pointer["run_id"] == "r2" and {e["run_id"] for e in dataset} == {"r2"}  # the partition was replaced
    # r1's file is still in the bucket for its citation, but no longer part of the current dataset
    assert (out / "lake" / "v1" / HR / "year=2025" / "month=12" / "part-r1-00000.parquet").exists()
    r1_dataset = (out / "lake" / "runs" / "r1" / "dataset.jsonl").read_text()
    assert "part-r1-00000" in r1_dataset


def test_untouched_partitions_keep_their_committed_files(tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert _run(_source(tmp_path / "s1", samples=[_sample(1, 3, month=11), _sample(2, 4, month=12)]), out, "r1") == 0
    assert _run(_source(tmp_path / "s2", samples=[_sample(3, 5, month=12)], name="B"), out, "r2") == 0
    pointer = json.loads((out / "lake" / "_current.json").read_text())
    dataset = [json.loads(line) for line in (out / "lake" / pointer["dataset"]).read_text().splitlines()]
    by_month = {(e["year"], e["month"]): e["run_id"] for e in dataset}
    assert by_month == {(2025, 11): "r1", (2025, 12): "r2"}
    assert len(_lake_rows(out)) == 3


def test_a_later_deletion_removes_the_published_row(tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert _run(_source(tmp_path / "s1", samples=[_sample(1, 3, month=11), _sample(2, 4, month=12)]), out, "r1") == 0
    assert len(_lake_rows(out)) == 2
    # r2 carries only a deletion for the November sample
    assert _run(_source(tmp_path / "s2", deletions=[1], name="B"), out, "r2") == 0
    rows = _lake_rows(out)
    assert [r[2] for r in rows] == ["2025-12"]
    pointer = json.loads((out / "lake" / "_current.json").read_text())
    dataset = [json.loads(line) for line in (out / "lake" / pointer["dataset"]).read_text().splitlines()]
    assert {(e["year"], e["month"]) for e in dataset} == {(2025, 12)}  # the emptied partition is gone


def test_a_deletion_before_its_sample_suppresses_the_replay(tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert _run(_source(tmp_path / "s1", samples=[_sample(2, 4)], deletions=[9]), out, "r1") == 0
    assert any((out / "ledger").rglob("*.parquet"))  # the unmatched retraction was kept
    assert _run(_source(tmp_path / "s2", samples=[_sample(9, 6), _sample(3, 7)], name="B"), out, "r2") == 0
    values = sorted(r[0] for r in _lake_rows(out))
    assert len(values) == 2  # sample 9 never appears


def test_concurrent_promoters_cannot_both_commit(tmp_path: Path) -> None:
    out_a, out_b = tmp_path / "a", tmp_path / "b"
    src = _source(tmp_path / "s", samples=[_sample(1, 3)])
    for out in (out_a, out_b):
        assert (
            main(
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
                    "--phases",
                    "work,compact,validate",
                ]
            )
            == 0
        )
    shared = LocalBlobStore(tmp_path / "shared-lake")

    def promote(out: Path):
        return promote_run(
            out / "compacted" / "r1",
            shared,
            "",
            run_id="r1",
            envelope=RunEnvelope.model_validate_json((out / "runs" / "r1" / "run.json").read_text()),
            validation=json.loads((out / "runs" / "r1" / "validation.json").read_text()),
            run_report=json.loads((out / "runs" / "r1" / "report.json").read_text()),
        )

    assert promote(out_a).committed
    second = promote(out_b)  # same run id and same content: recognised as already committed
    assert second.already_committed and not second.committed


def test_pointer_compare_and_swap(tmp_path: Path) -> None:
    store = LocalBlobStore(tmp_path)
    store.write_versioned("_current.json", b"one", None)
    data, token = store.read_versioned("_current.json")
    store.write_versioned("_current.json", b"two", token)
    with pytest.raises(BlobConflict):
        store.write_versioned("_current.json", b"three", token)  # stale token
    with pytest.raises(BlobConflict):
        store.write_versioned("_current.json", b"x", None)  # must not exist
    assert store.read("_current.json") == b"two"


def test_promote_refuses_when_the_base_moved(tmp_path: Path) -> None:
    out = tmp_path / "out"
    src = _source(tmp_path / "s", samples=[_sample(1, 3)])
    assert (
        main(
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
                "--phases",
                "work,compact,validate",
            ]
        )
        == 0
    )
    # someone else commits r0 to the same lake after r1 was validated against the empty lake
    other = tmp_path / "other"
    assert _run(_source(tmp_path / "s0", samples=[_sample(5, 1)], name="Z"), other, "r0") == 0
    import shutil

    shutil.copytree(other / "lake", out / "lake", dirs_exist_ok=True)
    with pytest.raises(PromoteConflict):
        promote_run(
            out / "compacted" / "r1",
            LocalBlobStore(out / "lake"),
            "",
            run_id="r1",
            envelope=RunEnvelope.model_validate_json((out / "runs" / "r1" / "run.json").read_text()),
            validation=json.loads((out / "runs" / "r1" / "validation.json").read_text()),
            run_report=json.loads((out / "runs" / "r1" / "report.json").read_text()),
        )
