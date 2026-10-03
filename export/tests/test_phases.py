# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path

import orjson
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import zstandard

from mhc_export.cli import main
from mhc_export.io.blobstore import LocalBlobStore
from mhc_export.run.compact import compact_run, list_compacted
from mhc_export.run.promote import PromoteConflict, promote_run, sanitize_report
from mhc_export.run.validate import PHI_PATTERNS, compacted_fingerprint, validate_run
from mhc_export.transform.specs import default_registry
from mhc_export.transform.writer import read_parquet_metadata
from tests.conftest import pre_grove_heart_rate
from tests.test_unit_e2e import TEST_KEY_HEX, UID, build_source

HR = "HKQuantityTypeIdentifierHeartRate"
UIDS = ["user-b", "user-a", "user-c"]


def _zstd(data: bytes) -> bytes:
    return zstandard.ZstdCompressor(write_content_size=False).compress(data)


def build_multi_source(root: Path) -> None:
    """Three users, heart rate only, two months, samples deliberately out of order inside each file."""
    for i, uid in enumerate(UIDS):
        hist = root / "users" / uid / "historicalHealthSamples"
        hist.mkdir(parents=True)
        samples = []
        for j in range(7):
            day = 1 + (j * 5) % 28
            month = 12 if j % 2 == 0 else 11
            samples.append(
                pre_grove_heart_rate(
                    id=f"{i:08x}-{j:04x}-4000-8000-000000000000",
                    identifier=[],
                    effectiveDateTime=f"2025-{month:02d}-{day:02d}T{(23 - j) % 24:02d}:00:00+01:00",
                )
            )
        samples.reverse()
        (hist / f"{HR}_A.json.zstd").write_bytes(_zstd(orjson.dumps(samples)))


def _run(tmp_path: Path, phases: str, extra: list[str] | None = None, multi: bool = False) -> tuple[Path, Path, int]:
    src = tmp_path / "src"
    out = tmp_path / "out"
    if not src.exists():
        (build_multi_source if multi else build_source)(src)
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
            "--phases",
            phases,
        ]
        + (extra or [])
    )
    return src, out, rc


def _all_rows(files: list[Path]) -> list[tuple[str, int]]:
    rows: list[tuple[str, int]] = []
    for f in files:
        t = pq.read_table(f, columns=["participant_id", "effective_start"])
        rows += list(zip(t.column(0).to_pylist(), t.column(1).cast(pa.int64()).to_pylist(), strict=True))
    return rows


def test_compaction_sorts_across_units_and_rolls_files(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work", multi=True)
    assert rc == 0
    staging = out / "staging" / "r1"
    compacted = out / "compacted" / "r1"
    assert len(list(staging.glob(f"{HR}/year=2025/month=12/*.parquet"))) == 3  # one part per unit
    results = compact_run(staging, compacted, run_id="r1", target_bytes=1, rows_per_batch=2)
    dec = next(r for r in results if r.key == f"{HR}/year=2025/month=12")
    assert dec.rows == 12 and len(dec.files) == 6  # 12 rows, 2 per batch, roll after every batch
    files = [Path(f) for f in dec.files]
    assert [f.name for f in files] == [f"part-{n:05d}.parquet" for n in range(6)]
    rows = _all_rows(files)
    assert rows == sorted(rows), "global order by participant then time must hold across file boundaries"
    assert len({r[0] for r in rows}) == 3
    for f in files:
        md = read_parquet_metadata(str(f))
        t = pq.read_table(f)
        starts = t.column("effective_start").cast(pa.int64()).to_pylist()
        lo = datetime.fromisoformat(md["covered_start"].replace("Z", "+00:00"))
        hi = datetime.fromisoformat(md["covered_end"].replace("Z", "+00:00"))
        assert int(lo.timestamp() * 1e6) == min(starts) and int(hi.timestamp() * 1e6) == max(starts)
        assert md["row_count"] == str(t.num_rows) and md["participant_count"] == str(
            len(set(t.column("participant_id").to_pylist()))
        )
        assert t.schema.equals(default_registry().get(HR).arrow_schema, check_metadata=False)
    manifest = json.loads((files[0].parent / "_manifest.json").read_text())
    assert manifest["rows"] == 12 and len(manifest["files"]) == 6 and len(manifest["source_parts"]) == 3


def test_compaction_redo_replaces_directory_and_is_byte_identical(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work", multi=True)
    assert rc == 0
    staging = out / "staging" / "r1"
    compacted = out / "compacted" / "r1"
    compact_run(staging, compacted, run_id="r1", target_bytes=1, rows_per_batch=2)
    out_dir = compacted / HR / "year=2025" / "month=12"
    before = {p.name: p.read_bytes() for p in out_dir.glob("part-*.parquet")}
    (out_dir / "part-00009.parquet").write_bytes(b"stale")
    (compacted / HR / "year=2025" / ".tmp-month=12-leftover").mkdir()
    compact_run(staging, compacted, run_id="r1", target_bytes=1, rows_per_batch=2)
    after = {p.name: p.read_bytes() for p in out_dir.glob("part-*.parquet")}
    assert after == before and "part-00009.parquet" not in after
    assert [f.name for _, _, _, fs in list_compacted(compacted) for f in fs] and not any(
        f.name.startswith(".") for _, _, _, fs in list_compacted(compacted) for f in fs
    )


def test_compaction_handles_missing_or_empty_staging(tmp_path: Path) -> None:
    assert compact_run(tmp_path / "nope", tmp_path / "c", run_id="r0") == []
    report = {"report": {"run_id": "r0", "units_total": 0, "units_done": 0, "units_failed": 0}, "units": {}}
    v = validate_run(tmp_path / "c", report, run_id="r0", uids=set())
    assert v.ok and v.files == 0


def _validated(tmp_path: Path) -> tuple[Path, Path, dict]:
    _, out, rc = _run(tmp_path, "work,compact")
    assert rc == 0
    compacted = out / "compacted" / "r1"
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    return out, compacted, report


def test_validate_passes_on_clean_run(tmp_path: Path) -> None:
    _, compacted, report = _validated(tmp_path)
    v = validate_run(compacted, report, run_id="r1", uids={UID})
    assert v.ok, v.failures()
    assert v.compacted_digest == compacted_fingerprint(compacted)[0] and v.files == 3
    names = {c.name for c in v.checks}
    expected = {
        "run_complete",
        "schema",
        "row_count",
        "unique_sample_id",
        "required_not_null",
        "value_nulls",
        "id_format",
        "partition",
        "period_order",
        "participant_not_uid",
        "phi_scan",
    }
    assert expected <= names


def _rewrite(path: Path, mutate) -> None:
    table = pq.read_table(path)
    pq.write_table(mutate(table), path)


@pytest.mark.parametrize(
    ("name", "mutation"),
    [
        ("run_complete", "report_failed"),
        ("run_complete", "report_run_id"),
        ("row_count", "report_rows"),
        ("present", "extra_type"),
        ("partition", "move_file"),
        ("unique_sample_id", "duplicate_rows"),
        ("schema", "drop_column"),
        ("period_order", "end_before_start"),
        ("required_not_null", "null_participant"),
        ("participant_not_uid", "uid_as_participant"),
        ("phi_scan", "device_name"),
        ("id_format", "bad_writer_id"),
    ],
)
def test_each_validation_check_can_fail(tmp_path: Path, name: str, mutation: str) -> None:
    _, compacted, report = _validated(tmp_path)
    hr_file = compacted / HR / "year=2026" / "month=01" / "part-00000.parquet"
    if mutation == "report_failed":
        report["report"]["units_failed"] = 1
        report["units"]["user-zzz:" + HR] = {"error": "boom"}
    elif mutation == "report_run_id":
        report["report"]["run_id"] = "other"
    elif mutation == "report_rows":
        report["units"][f"{UID}:{HR}"]["rows_out"] += 1
    elif mutation == "extra_type":
        shutil.copytree(compacted / HR, compacted / "HKQuantityTypeIdentifierVO2Max")
    elif mutation == "move_file":
        shutil.copy(hr_file, compacted / HR / "year=2025" / "month=12" / "part-00007.parquet")
    elif mutation == "duplicate_rows":
        _rewrite(hr_file, lambda t: pa.concat_tables([t, t]))
    elif mutation == "drop_column":
        _rewrite(hr_file, lambda t: t.drop_columns(["motion_context"]))
    elif mutation == "end_before_start":
        _rewrite(
            hr_file,
            lambda t: t.set_column(
                t.schema.get_field_index("effective_end"),
                "effective_end",
                pa.array([datetime(2000, 1, 1, tzinfo=UTC)] * t.num_rows, pa.timestamp("us", tz="UTC")),
            ),
        )
    elif mutation == "null_participant":
        _rewrite(
            hr_file,
            lambda t: t.set_column(
                t.schema.get_field_index("participant_id"),
                pa.field("participant_id", pa.string()),
                pa.array([None] * t.num_rows, pa.string()),
            ),
        )
    elif mutation == "uid_as_participant":
        _rewrite(
            hr_file,
            lambda t: t.set_column(
                t.schema.get_field_index("participant_id"), "participant_id", pa.array([UID] * t.num_rows)
            ),
        )
    elif mutation == "device_name":
        _rewrite(
            hr_file,
            lambda t: t.set_column(
                t.schema.get_field_index("device_model"), "device_model", pa.array(["Lukas' Apple Watch"] * t.num_rows)
            ),
        )
    elif mutation == "bad_writer_id":
        _rewrite(
            hr_file,
            lambda t: t.set_column(
                t.schema.get_field_index("writer_record_id"),
                "writer_record_id",
                pa.array(["raw-sync-identifier"] * t.num_rows),
            ),
        )
    v = validate_run(compacted, report, run_id="r1", uids={UID})
    assert not v.ok
    assert name in {c.name for c in v.failures()}, [c.model_dump() for c in v.failures()]


def test_phi_scan_samples_every_file_not_just_the_first(tmp_path: Path) -> None:
    _, compacted, report = _validated(tmp_path)
    last = sorted(compacted.rglob("part-*.parquet"))[-1]
    _rewrite(
        last,
        lambda t: t.set_column(
            t.schema.get_field_index("device_model"),
            "device_model",
            pa.array(["mail me at phi@example.org"] * t.num_rows),
        ),
    )
    v = validate_run(compacted, report, run_id="r1", uids={UID}, sample_rows=1)
    assert any(c.name == "phi_scan" and not c.ok for c in v.checks)


def test_promote_guards_and_idempotency(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate,promote", ["--batch-end", "2026-01-01T00:00:00Z"])
    assert rc == 0
    lake_dir = out / "lake"
    lake = LocalBlobStore(lake_dir)
    files = sorted(p.relative_to(lake_dir).as_posix() for p in lake_dir.rglob("*.parquet"))
    assert files[0] == f"v1/{HR}/year=2025/month=12/part-r1-00000.parquet"
    snapshot = (lake_dir / "runs" / "r1" / "snapshot.jsonl").read_text()
    assert len(snapshot.splitlines()) == len(files)
    watermark = json.loads((lake_dir / "runs" / "_watermark.json").read_text())
    assert watermark["run_id"] == "r1" and watermark["batch_end"].startswith("2026-01-01")
    summary = (lake_dir / "runs" / "r1" / "summary.json").read_text()
    assert UID not in summary and "parts" not in summary and json.loads(summary)["report"]["rows_out"] == 6
    assert not (lake_dir / "runs" / "r1" / "report.json").exists()
    compacted = out / "compacted" / "r1"
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    kw = dict(run_id="r1", validation=validation, run_report=report)
    # redo: nothing copied, snapshot untouched, watermark untouched
    again = promote_run(compacted, lake, "", batch_end=datetime(2026, 1, 1, tzinfo=UTC), **kw)
    assert (
        again.copied == 0 and again.skipped == len(files) and not again.snapshot_written and not again.watermark_updated
    )
    assert (lake_dir / "runs" / "r1" / "snapshot.jsonl").read_text() == snapshot
    # guards
    with pytest.raises(PromoteConflict):
        promote_run(compacted, lake, "", batch_end=None, run_id="r1", validation={"ok": False}, run_report=report)
    with pytest.raises(PromoteConflict):
        promote_run(
            compacted,
            lake,
            "",
            batch_end=None,
            run_id="r1",
            validation=dict(validation, run_id="r9"),
            run_report=report,
        )
    with pytest.raises(PromoteConflict):
        promote_run(
            compacted,
            lake,
            "",
            batch_end=None,
            run_id="r1",
            validation=dict(validation, compacted_digest="0" * 64),
            run_report=report,
        )
    # same size, different content under an existing name is a conflict
    target = lake_dir / files[0]
    original = target.read_bytes()
    target.write_bytes(bytes(len(original)))
    with pytest.raises(PromoteConflict):
        promote_run(compacted, lake, "", batch_end=None, **kw)
    target.write_bytes(original)
    # watermark never regresses and ignores a missing batch end
    older = promote_run(compacted, lake, "", batch_end=datetime(2025, 12, 1, tzinfo=UTC), **kw)
    assert (
        not older.watermark_updated
        and json.loads((lake_dir / "runs" / "_watermark.json").read_text())["run_id"] == "r1"
    )
    assert not promote_run(compacted, lake, "", batch_end=None, **kw).watermark_updated
    newer = promote_run(compacted, lake, "", batch_end=datetime(2026, 2, 1, tzinfo=UTC), **kw)
    assert newer.watermark_updated and json.loads((lake_dir / "runs" / "_watermark.json").read_text())[
        "batch_end"
    ].startswith("2026-02-01")


def test_snapshot_lists_only_v1_prefix(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate,promote")
    assert rc == 0
    lake_dir = out / "lake"
    (lake_dir / "v1-old").mkdir()
    (lake_dir / "v1-old" / "junk.parquet").write_bytes(b"x")
    compacted = out / "compacted" / "r1"
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    (lake_dir / "runs" / "r1" / "snapshot.jsonl").unlink()
    promote_run(
        compacted, LocalBlobStore(lake_dir), "", run_id="r1", batch_end=None, validation=validation, run_report=report
    )
    lines = (lake_dir / "runs" / "r1" / "snapshot.jsonl").read_text().splitlines()
    assert lines and all("/v1/" in json.loads(line)["uri"] for line in lines)


def test_sanitize_report_strips_identifiers() -> None:
    raw = {
        "report": {
            "run_id": "r",
            "units_total": 1,
            "units_done": 1,
            "units_failed": 0,
            "rows_out": 5,
            "seconds": 1.0,
            "totals": {"rows_out": 5, "parts": ["staging/r/T/year=2026/month=01/uid-123__T.parquet"]},
            "per_sample_type": {"T": {"rows_out": 5, "parts": ["staging/r/T/year=2026/month=01/uid-123__T.parquet"]}},
        },
        "units": {"uid-123:T": {"rows_out": 5, "parts": ["x"]}, "uid-123:ECG": {"skipped_reason": "unmodeled"}},
    }
    clean = json.dumps(sanitize_report(raw))
    assert "uid-123" not in clean and "parts" not in clean and '"skipped_types": ["ECG"]' in clean


def test_run_local_stops_on_failed_validation(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact")
    assert rc == 0
    report_path = out / "runs" / "r1" / "report.json"
    report = json.loads(report_path.read_text())
    report["units"][f"{UID}:HKQuantityTypeIdentifierStepCount"]["rows_out"] = 99
    report_path.write_text(json.dumps(report))
    _, _, rc2 = _run(tmp_path, "validate,promote")
    assert rc2 == 2 and not (out / "lake").exists()


def test_phi_patterns_match_text_not_version_numbers() -> None:
    phone = re.compile(PHI_PATTERNS["phone"])
    assert phone.search("+1 650 555 0199") and phone.search("call 650-555-0199 now") and phone.search("(650) 555-0123")
    assert not phone.search("1631374755") and not phone.search("42")
    name = re.compile(PHI_PATTERNS["possessive_name"])
    assert name.search("Lukas' Apple Watch") and name.search("Paul's iPhone") and name.search("Apple Watch von Paul")
    assert name.search("iPhone de Paul")
    assert not name.search("Apple Watch") and not name.search("iPhone18,2")
    bundle = re.compile(PHI_PATTERNS["source_bundle_uuid"])
    assert bundle.search("com.apple.health.386C8A18-82D3-465E-8698-960FB468ABB3")
    assert not bundle.search("com.apple.health.fitnessmachinemodel.treadmill") and not bundle.search(
        "com.apple.shortcuts"
    )


def test_filtered_run_never_validates(tmp_path: Path) -> None:
    _, out, rc = _run(
        tmp_path, "work,compact,validate", ["--limit-units", "1", "--batch-end", "2026-01-01T00:00:00Z"], multi=True
    )
    assert rc == 2
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    failures = [c for c in validation["checks"] if not c["ok"]]
    assert [c["name"] for c in failures] == ["run_complete"] and "filtered" in failures[0]["detail"]
    assert not (out / "lake").exists()


def test_run_complete_checks_manifest_and_planned_units(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact", multi=True)
    assert rc == 0
    compacted = out / "compacted" / "r1"
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    from mhc_export.run.manifest import load_manifest

    manifest = load_manifest((out / "runs" / "r1" / "manifest.jsonl").read_bytes())
    assert validate_run(compacted, report, run_id="r1", uids=set(UIDS), manifest=manifest).ok
    # a unit silently missing from the report while the manifest lists it
    dropped = {k: v for k, v in report["units"].items() if not k.startswith("user-c")}
    trimmed = dict(report, units=dropped)
    trimmed["report"] = dict(report["report"], units_total=2, units_done=2, planned_units=2)
    v = validate_run(compacted, trimmed, run_id="r1", uids=set(UIDS), manifest=manifest)
    assert not v.ok and any("differs from manifest" in c.detail for c in v.failures())
    # planned units larger than worked units, no manifest given
    short = dict(report, report=dict(report["report"], planned_units=5))
    v2 = validate_run(compacted, short, run_id="r1", uids=set(UIDS))
    assert not v2.ok and any("planned" in c.detail for c in v2.failures())


def test_promote_rejects_changed_report_and_different_file_set(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate,promote", multi=True)
    assert rc == 0
    lake_dir = out / "lake"
    compacted = out / "compacted" / "r1"
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    changed = json.loads(json.dumps(report))
    changed["report"]["units_failed"] = 1
    with pytest.raises(PromoteConflict, match="run report changed"):
        promote_run(
            compacted,
            LocalBlobStore(lake_dir),
            "",
            run_id="r1",
            batch_end=None,
            validation=validation,
            run_report=changed,
        )
    # redo of the same run id after the lake recorded a different compacted set
    recorded = lake_dir / "runs" / "r1" / "validation.json"
    stored = json.loads(recorded.read_text())
    stored["compacted_digest"] = "0" * 64
    recorded.write_text(json.dumps(stored))
    with pytest.raises(PromoteConflict, match="different file set"):
        promote_run(
            compacted,
            LocalBlobStore(lake_dir),
            "",
            run_id="r1",
            batch_end=None,
            validation=validation,
            run_report=report,
        )


def test_phi_scan_sampled_branch_finds_planted_text(tmp_path: Path) -> None:
    import duckdb
    import pyarrow.compute as pc

    from mhc_export.run.validate import _phi_scan
    from mhc_export.transform.specs import default_registry

    spec = default_registry().get(HR)
    assert spec
    base = pq.read_table(_validated(tmp_path)[1] / HR / "year=2025" / "month=12" / "part-00000.parquet")
    big = pa.concat_tables([base] * 2000)  # 8000 rows, several DuckDB vectors
    big = big.set_column(
        big.schema.get_field_index("device_model"), "device_model", pa.array(["Pauls iPhone von Paul"] * big.num_rows)
    )
    root = tmp_path / "phi" / HR / "year=2025" / "month=12"
    root.mkdir(parents=True)
    pq.write_table(big, root / "part-00000.parquet", row_group_size=2048)
    glob = str(tmp_path / "phi" / HR / "year=*" / "month=*" / "part-*.parquet")
    con = duckdb.connect()
    check = _phi_scan(con, glob, spec, sample_rows=2048, total_rows=big.num_rows)
    assert not check.ok and "device_model:possessive_name" in check.detail
    clean = big.set_column(
        big.schema.get_field_index("device_model"), "device_model", pa.array(["Watch"] * big.num_rows)
    )
    pq.write_table(clean, root / "part-00000.parquet", row_group_size=2048)
    check2 = _phi_scan(con, glob, spec, sample_rows=2048, total_rows=big.num_rows)
    assert check2.ok and ("rows sampled" in check2.detail or "all" in check2.detail)
    assert pc.sum(pa.array([1])).as_py() == 1


def test_compact_parser_has_gcs_options_and_requires_work_dir() -> None:
    from mhc_export.cli import build_parser

    args = build_parser().parse_args(
        [
            "compact",
            "--staging",
            "gs://b/staging/r1",
            "--out",
            "/tmp/o",
            "--run-id",
            "r1",
            "--work-dir",
            "/tmp/w",
            "--project",
            "p",
        ]
    )
    assert args.work_dir == "/tmp/w" and args.project == "p"
    with pytest.raises(SystemExit):
        main(["compact", "--staging", "gs://b/staging/r1", "--out", "/tmp/o", "--run-id", "r1"])


def test_sync_prefix_redownloads_when_generation_changes(tmp_path: Path) -> None:
    from mhc_export.io.blobstore import ObjectInfo, sync_prefix

    class FakeStore:
        def __init__(self) -> None:
            self.objects = {"gs://b/staging/r1/T/year=2026/month=01/u.parquet": (b"aaaa", 1)}
            self.reads = 0

        def list(self, prefix: str):
            for uri, (data, gen) in self.objects.items():
                if uri.startswith(prefix):
                    yield ObjectInfo(uri, len(data), gen, None, {})

        def read(self, uri: str, generation=None) -> bytes:
            self.reads += 1
            return self.objects[uri][0]

    store = FakeStore()
    local = tmp_path / "work"
    files = sync_prefix(store, "gs://b/staging/r1", local)
    assert [f.relative_to(local).as_posix() for f in files] == ["T/year=2026/month=01/u.parquet"] and store.reads == 1
    sync_prefix(store, "gs://b/staging/r1", local)
    assert store.reads == 1  # unchanged size and generation: reused
    store.objects["gs://b/staging/r1/T/year=2026/month=01/u.parquet"] = (b"bbbb", 2)  # same size, new generation
    sync_prefix(store, "gs://b/staging/r1", local)
    assert store.reads == 2 and files[0].read_bytes() == b"bbbb"
