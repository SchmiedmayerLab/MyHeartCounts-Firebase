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
from mhc_export.io.blobstore import LocalBlobStore, RoutedStore
from mhc_export.run.compact import compact_run, list_compacted
from mhc_export.run.envelope import RunEnvelope
from mhc_export.run.inputs import RunInputs, gather_inputs
from mhc_export.run.promote import PromoteConflict, promote_run, sanitize_report
from mhc_export.run.validate import PHI_PATTERNS, compacted_fingerprint, validate_run
from mhc_export.transform.project import ProjectContext
from mhc_export.transform.specs import default_registry
from mhc_export.transform.writer import read_parquet_metadata
from tests.conftest import pre_grove_heart_rate
from tests.test_unit_e2e import TEST_KEY_HEX, UID, build_source


def _inputs_for(compacted_or_staging: Path) -> RunInputs:
    """Inputs of a local run whose state root is out/ (staging under out/staging/{run}, lake under out/lake)."""
    out, run_id = compacted_or_staging.parent.parent, compacted_or_staging.name
    return gather_inputs(
        lake=LocalBlobStore(out / "lake"),
        lake_prefix="",
        state=LocalBlobStore(out),
        state_prefix="",
        run_id=run_id,
        work_dir=out / "work",
    )


def _compact(staging: Path, compacted: Path, **kw) -> list:
    return compact_run(_inputs_for(staging), compacted, **kw)


def _validate(compacted: Path, report: dict, **kw):
    return validate_run(compacted, report, inputs=_inputs_for(compacted), **kw)


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
    results = _compact(staging, compacted, run_id="r1", target_bytes=1, rows_per_batch=2)
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
    assert manifest["rows"] == 12 and len(manifest["files"]) == 6 and len(manifest["staged_parts"]) == 3


def test_compaction_redo_replaces_directory_and_is_byte_identical(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work", multi=True)
    assert rc == 0
    staging = out / "staging" / "r1"
    compacted = out / "compacted" / "r1"
    _compact(staging, compacted, run_id="r1", target_bytes=1, rows_per_batch=2)
    out_dir = compacted / HR / "year=2025" / "month=12"
    before = {p.name: p.read_bytes() for p in out_dir.glob("part-*.parquet")}
    (out_dir / "part-00009.parquet").write_bytes(b"stale")
    (compacted / HR / "year=2025" / ".tmp-month=12-leftover").mkdir()
    _compact(staging, compacted, run_id="r1", target_bytes=1, rows_per_batch=2)
    after = {p.name: p.read_bytes() for p in out_dir.glob("part-*.parquet")}
    assert after == before and "part-00009.parquet" not in after
    assert [f.name for _, _, _, fs in list_compacted(compacted) for f in fs] and not any(
        f.name.startswith(".") for _, _, _, fs in list_compacted(compacted) for f in fs
    )


def test_compaction_handles_missing_or_empty_staging(tmp_path: Path) -> None:
    compacted = tmp_path / "compacted" / "r0"
    assert _compact(tmp_path / "staging" / "r0", compacted, run_id="r0") == []
    assert json.loads((compacted / "_touched.json").read_text())["partitions"] == []
    report = {"report": {"run_id": "r0", "units_total": 0, "units_done": 0, "units_failed": 0}, "units": {}}
    v = _validate(compacted, report, run_id="r0", uids=set())
    assert v.ok and v.files == 0


def _validated(tmp_path: Path) -> tuple[Path, Path, dict]:
    _, out, rc = _run(tmp_path, "work,compact")
    assert rc == 0
    compacted = out / "compacted" / "r1"
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    return out, compacted, report


def test_validate_passes_on_clean_run(tmp_path: Path) -> None:
    _, compacted, report = _validated(tmp_path)
    v = _validate(compacted, report, run_id="r1", uids={UID})
    assert v.ok, v.failures()
    assert v.compacted_digest == compacted_fingerprint(compacted)[0] and v.files == 3
    names = {c.name for c in v.checks}
    expected = {
        "run_complete",
        "schema",
        "staging_matches_report",
        "partition_rows",
        "touched_covers_staged",
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
        ("staging_matches_report", "report_rows"),
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
    v = _validate(compacted, report, run_id="r1", uids={UID})
    assert not v.ok
    assert name in {c.name for c in v.failures()}, [c.model_dump() for c in v.failures()]


def test_phi_scan_covers_every_distinct_value_in_every_file(tmp_path: Path) -> None:
    _, compacted, report = _validated(tmp_path)
    files = sorted(compacted.rglob("part-*.parquet"))
    last = files[-1]
    _rewrite(
        last,
        lambda t: t.set_column(
            t.schema.get_field_index("device_model"),
            "device_model",
            pa.array(["mail me at phi@example.org"] * t.num_rows),
        ),
    )
    v = _validate(compacted, report, run_id="r1", uids={UID})
    failed = [c for c in v.checks if c.name == "phi_scan" and not c.ok]
    assert failed and "device_model:email" in failed[0].detail
    clean = [c for c in v.checks if c.name == "phi_scan" and c.ok]
    assert clean and "distinct values" in clean[0].detail


def _env(out: Path, run_id: str = "r1") -> RunEnvelope:
    return RunEnvelope.model_validate_json((out / "runs" / run_id / "run.json").read_text())


def test_promote_guards_and_idempotency(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate,promote", ["--batch-end", "2026-01-01T00:00:00Z"])
    assert rc == 0
    lake_dir = out / "lake"
    lake = LocalBlobStore(lake_dir)
    files = sorted(p.relative_to(lake_dir).as_posix() for p in lake_dir.rglob("*.parquet"))
    assert files[0] == f"v1/{HR}/year=2025/month=12/part-r1-00000.parquet"
    pointer = json.loads((lake_dir / "_current.json").read_text())
    assert (
        pointer["run_id"] == "r1" and pointer["batch_end"].startswith("2026-01-01") and pointer["files"] == len(files)
    )
    dataset = (lake_dir / "runs" / "r1" / "dataset.jsonl").read_text().splitlines()
    assert sorted(json.loads(line)["path"] for line in dataset) == files
    assert all(json.loads(line)["participant_min"] for line in dataset)
    summary = (lake_dir / "runs" / "r1" / "summary.json").read_text()
    assert UID not in summary and "parts" not in summary and json.loads(summary)["report"]["rows_out"] == 6
    assert (
        not (lake_dir / "runs" / "r1" / "report.json").exists() and not (lake_dir / "runs" / "r1" / "run.json").exists()
    )
    compacted = out / "compacted" / "r1"
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    env = _env(out)
    kw = dict(run_id="r1", envelope=env, validation=validation, run_report=report)
    # redo of the committed run: a no-op
    again = promote_run(compacted, lake, "", **kw)
    assert again.already_committed and again.copied == 0 and not again.committed
    assert json.loads((lake_dir / "_current.json").read_text()) == pointer
    # guards apply before anything else
    for bad in (
        {"ok": False},
        dict(validation, run_id="r9"),
        dict(validation, compacted_digest="0" * 64),
        dict(validation, envelope_sha256="0" * 64),
    ):
        with pytest.raises(PromoteConflict):
            promote_run(compacted, lake, "", run_id="r1", envelope=env, validation=bad, run_report=report)
    scoped = env.model_copy(update={"scoped": True})
    with pytest.raises(PromoteConflict, match="run envelope"):
        promote_run(compacted, lake, "", run_id="r1", envelope=scoped, validation=validation, run_report=report)
    # a fresh lake: an existing object under a run file name with different content is a conflict
    other = LocalBlobStore(tmp_path / "other-lake")
    (tmp_path / "other-lake" / files[0]).parent.mkdir(parents=True)
    (tmp_path / "other-lake" / files[0]).write_bytes(bytes((lake_dir / files[0]).stat().st_size))
    fresh_validation = dict(validation, base_dataset_sha256=None)
    with pytest.raises(PromoteConflict, match="different content"):
        promote_run(compacted, other, "", run_id="r1", envelope=env, validation=fresh_validation, run_report=report)


def test_promotion_rules_and_contiguity() -> None:
    from datetime import UTC, datetime

    from mhc_export.run.envelope import Eligibility, contiguity_problem, promotion_problems

    jan, feb, mar = (datetime(2026, m, 1, tzinfo=UTC) for m in (1, 2, 3))
    env = RunEnvelope(
        run_id="r2",
        batch_start=jan,
        batch_end=feb,
        window_applied=True,
        scoped=False,
        source="gs://src",
        manifest_sha256="0" * 64,
        unit_count=1,
        eligibility=Eligibility(source="firestore"),
        grove_version="0.6.0",
        registry_commit="e04ab86",
        package_version="0.1.0",
        created_at=jan,
    )
    assert promotion_problems(env, production_lake=True) == []
    assert promotion_problems(env.model_copy(update={"scoped": True}), production_lake=False)
    local_only = env.model_copy(update={"window_applied": False, "eligibility": Eligibility(source="unchecked")})
    assert promotion_problems(local_only, production_lake=False) == []
    assert len(promotion_problems(local_only, production_lake=True)) == 2
    assert promotion_problems(env.model_copy(update={"batch_end": None}), production_lake=True)
    assert contiguity_problem(env, {"run_id": "r1", "batch_end": jan.isoformat()}) is None
    assert contiguity_problem(env, {"run_id": "r2", "batch_end": feb.isoformat()}) is None  # redo
    assert contiguity_problem(env, {"run_id": "r1", "batch_end": mar.isoformat()})
    assert contiguity_problem(env, None)  # first run must start at the beginning
    assert contiguity_problem(env.model_copy(update={"batch_start": None}), None) is None


def test_dataset_manifest_lists_only_committed_files(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate,promote")
    assert rc == 0
    lake_dir = out / "lake"
    (lake_dir / "v1-old").mkdir()
    (lake_dir / "v1-old" / "junk.parquet").write_bytes(b"x")
    (lake_dir / "v1" / HR / "year=1999" / "month=01").mkdir(parents=True)
    (lake_dir / "v1" / HR / "year=1999" / "month=01" / "stray.parquet").write_bytes(b"y")
    pointer = json.loads((lake_dir / "_current.json").read_text())
    paths = [json.loads(line)["path"] for line in (lake_dir / pointer["dataset"]).read_text().splitlines()]
    assert paths and all(p.startswith("v1/") and "stray" not in p for p in paths)


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
    assert rc2 == 2 and not (out / "lake" / "_current.json").exists()


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
    assert not (out / "lake" / "_current.json").exists()


def test_run_complete_checks_manifest_and_planned_units(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact", multi=True)
    assert rc == 0
    compacted = out / "compacted" / "r1"
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    from mhc_export.run.manifest import load_manifest

    manifest = load_manifest((out / "runs" / "r1" / "manifest.jsonl").read_bytes())
    assert _validate(compacted, report, run_id="r1", uids=set(UIDS), manifest=manifest).ok
    # a unit silently missing from the report while the manifest lists it
    dropped = {k: v for k, v in report["units"].items() if not k.startswith("user-c")}
    trimmed = dict(report, units=dropped)
    trimmed["report"] = dict(report["report"], units_total=2, units_done=2, planned_units=2)
    v = _validate(compacted, trimmed, run_id="r1", uids=set(UIDS), manifest=manifest)
    assert not v.ok and any("differs from manifest" in c.detail for c in v.failures())
    # planned units larger than worked units, no manifest given
    short = dict(report, report=dict(report["report"], planned_units=5))
    v2 = _validate(compacted, short, run_id="r1", uids=set(UIDS))
    assert not v2.ok and any("planned" in c.detail for c in v2.failures())


def test_promote_rejects_changed_report_and_stale_base(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate", multi=True)
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
            envelope=_env(out),
            validation=validation,
            run_report=changed,
        )
    # validated against an empty lake, but the lake moved on meanwhile
    stale = dict(validation, base_dataset_sha256="f" * 64)
    with pytest.raises(PromoteConflict, match="lake changed"):
        promote_run(
            compacted,
            LocalBlobStore(lake_dir),
            "",
            run_id="r1",
            envelope=_env(out),
            validation=stale,
            run_report=report,
        )


def test_compact_and_validate_need_state_lake_and_work_dir() -> None:
    from mhc_export.cli import build_parser

    args = build_parser().parse_args(
        [
            "compact",
            "--state",
            "gs://s",
            "--lake",
            "gs://l",
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
    assert args.work_dir == "/tmp/w" and args.project == "p" and args.state == "gs://s" and args.lake == "gs://l"
    for missing in ("--work-dir", "--lake", "--state"):
        argv = [
            "compact",
            "--state",
            "gs://s",
            "--lake",
            "gs://l",
            "--out",
            "/tmp/o",
            "--run-id",
            "r1",
            "--work-dir",
            "/tmp/w",
        ]
        i = argv.index(missing)
        with pytest.raises(SystemExit):
            build_parser().parse_args(argv[:i] + argv[i + 2 :])


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


def test_unreadable_input_fails_closed_unless_tolerated(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    bad = src / "users" / UID / "historicalHealthSamples" / "HKQuantityTypeIdentifierHeartRate_FFFF.json.zstd"
    bad.write_bytes(b"\x28\xb5\x2f\xfdgarbage")
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
            "--phases",
            "work",
        ]
    )
    assert rc == 1
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    assert "unreadable_object" in report["units"][f"{UID}:{HR}"]["error"]
    rc2 = main(
        [
            "run-local",
            "--source",
            str(src),
            "--out",
            str(out),
            "--run-id",
            "r2",
            "--key-hex",
            TEST_KEY_HEX,
            "--allow-test-key",
            "--phases",
            "work,compact,validate",
            "--tolerate-fatal",
            "1",
        ]
    )
    assert rc2 == 0
    report2 = json.loads((out / "runs" / "r2" / "report.json").read_text())
    assert (
        report2["units"][f"{UID}:{HR}"]["fatal"] == {"unreadable_object": 1}
        and report2["report"]["tolerated_fatal"] == 1
    )
    # the same report with the tolerance removed must fail completeness
    report2["report"]["tolerated_fatal"] = 0
    v = _validate(out / "compacted" / "r2", report2, run_id="r2", uids={UID})
    assert not v.ok and any("fatal input errors" in c.detail for c in v.failures())


def test_promote_verifies_uploaded_content_against_validation(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate")
    assert rc == 0
    compacted = out / "compacted" / "r1"
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    assert all(len(e["md5"]) == 32 for e in validation["entries"])
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    # tamper with a compacted file after validation: same size and rows, different bytes
    part = compacted / HR / "year=2026" / "month=01" / "part-00000.parquet"
    original = part.read_bytes()
    part.write_bytes(original[:120] + bytes([original[120] ^ 1]) + original[121:])
    with pytest.raises(PromoteConflict, match="changed since validation"):
        promote_run(
            compacted,
            LocalBlobStore(tmp_path / "lake"),
            "",
            run_id="r1",
            envelope=_env(out),
            validation=validation,
            run_report=report,
        )


def test_redo_removes_stale_parts_via_sidecar(tmp_path: Path) -> None:
    from mhc_export.config import IdentityConfig
    from mhc_export.identity.participants import LocalParticipantLookup
    from mhc_export.run.unit import Deps, process_unit, unit_sidecar_uri
    from mhc_export.sources.bucket import plan_units
    from tests.conftest import TEST_KEY

    src = tmp_path / "src"
    build_source(src)
    store = LocalBlobStore(tmp_path)
    unit = plan_units(LocalBlobStore(src).list(""), sample_types={HR})[0]
    deps = Deps(
        store=RoutedStore(LocalBlobStore(src), store),
        registry=default_registry(),
        identity=IdentityConfig(TEST_KEY),
        participants=LocalParticipantLookup(tmp_path / "p.json"),
        staging_prefix="staging/r1",
        run_id="r1",
    )
    first = process_unit(unit, deps)
    assert len(first.parts) == 2 and store.exists(unit_sidecar_uri("staging/r1", unit))
    # the live file disappears: the redo yields one month and must delete the other month's part
    (src / "users" / UID / "liveHealthSamples" / "HKQuantityTypeIdentifierHeartRate_B.json.zstd").unlink()
    unit2 = plan_units(LocalBlobStore(src).list(""), sample_types={HR})[0]
    second = process_unit(unit2, deps)
    assert len(second.parts) == 1
    assert not store.exists([p for p in first.parts if p not in second.parts][0])


def test_grove_identity_guards(ctx: ProjectContext) -> None:
    from mhc_export.config import IdentityConfig
    from mhc_export.grove.view import parse_observation
    from mhc_export.transform.project import ProjectError, project
    from tests.conftest import TEST_KEY

    config = IdentityConfig(TEST_KEY, deployment_root="https://mhc.example/fhir")
    guarded = ProjectContext(
        ctx.participant_id, ctx.identity, ctx.run_id, ctx.upload_kind, ctx.from_archive, config=config
    )
    role = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role"
    hk_id = ctx.identity
    good_rec = hk_id.source_record(HR, "BDAC71F6-3398-4BDD-A56C-7BD50988D87A")
    good_out = hk_id.source_output(HR, "BDAC71F6-3398-4BDD-A56C-7BD50988D87A", "heart-rate")

    def obs(rec_sys: str, rec_val: str, out_sys: str, out_val: str, extra=None) -> dict:
        ids = [
            {"type": {"coding": [{"system": role, "code": "source-record"}]}, "system": rec_sys, "value": rec_val},
            {"type": {"coding": [{"system": role, "code": "source-output"}]}, "system": out_sys, "value": out_val},
        ] + (extra or [])
        return {
            "resourceType": "Observation",
            "status": "final",
            "identifier": ids,
            "extension": [
                {
                    "url": "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-source-type",
                    "valueCode": HR,
                }
            ],
            "effectiveDateTime": "2026-08-07T16:03:37.797-07:00",
            "valueQuantity": {
                "value": 84,
                "unit": "beats/minute",
                "code": "/min",
                "system": "http://unitsofmeasure.org",
            },
        }

    spec = default_registry().get(HR)
    ok = obs(hk_id.system("source-record"), good_rec, hk_id.system("source-output"), good_out)
    assert project(parse_observation(ok), spec, guarded, 1).row["sample_id"] == good_out
    foreign_key = obs(hk_id.system("source-record"), "v0:other:1:" + "A" * 43, hk_id.system("source-output"), good_out)
    with pytest.raises(ProjectError, match="foreign_identity"):
        project(parse_observation(foreign_key), spec, guarded, 1)
    foreign_system = obs("https://elsewhere.example/sr", good_rec, hk_id.system("source-output"), good_out)
    with pytest.raises(ProjectError, match="foreign_identity"):
        project(parse_observation(foreign_system), spec, guarded, 1)
    dup = obs(
        hk_id.system("source-record"),
        good_rec,
        hk_id.system("source-output"),
        good_out,
        extra=[
            {
                "type": {"coding": [{"system": role, "code": "source-output"}]},
                "system": hk_id.system("source-output"),
                "value": good_out,
            }
        ],
    )
    with pytest.raises(ProjectError, match="duplicate_grove_identity"):
        project(parse_observation(dup), spec, guarded, 1)
    # an older epoch is accepted only when listed
    from mhc_export.identity.grove_ids import GroveKey

    old_key = GroveKey(TEST_KEY.secret, "test-key", 1)
    newer = IdentityConfig(GroveKey(TEST_KEY.secret, "test-key", 2), deployment_root="https://mhc.example/fhir")
    newer_ctx = ProjectContext(
        ctx.participant_id, ctx.identity, ctx.run_id, ctx.upload_kind, ctx.from_archive, config=newer
    )
    with pytest.raises(ProjectError, match="foreign_identity"):
        project(parse_observation(ok), spec, newer_ctx, 1)
    rotated = IdentityConfig(
        newer.key, deployment_root="https://mhc.example/fhir", accepted_epochs=((old_key.key_id, 1),)
    )
    rotated_ctx = ProjectContext(
        ctx.participant_id, ctx.identity, ctx.run_id, ctx.upload_kind, ctx.from_archive, config=rotated
    )
    assert project(parse_observation(ok), spec, rotated_ctx, 1).row["sample_id"] == good_out


def test_report_carries_identity_config_and_validation_checks_namespace(tmp_path: Path) -> None:
    _, out, rc = _run(tmp_path, "work,compact,validate")
    assert rc == 0
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    ident = report["report"]["identity"]
    assert ident["key_id"] == "local" and ident["key_epoch"] == 1 and ident["accepted_epochs"] == ["local:1"]
    assert "secret" not in json.dumps(ident).lower() and TEST_KEY_HEX not in json.dumps(report)
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    assert any(c["name"] == "identity_namespace" and c["ok"] for c in validation["checks"])
    report["report"]["identity"]["accepted_epochs"] = ["other:9"]
    v = _validate(out / "compacted" / "r1", report, run_id="r1", uids={UID})
    assert any(c.name == "identity_namespace" and not c.ok for c in v.checks)


def test_production_mode_refuses_local_setup(tmp_path: Path) -> None:
    from mhc_export.identity.grove_ids import IdentityError

    _, out, rc = _run(tmp_path, "work")
    assert rc == 0
    with pytest.raises(IdentityError, match="production mode"):
        main(
            [
                "run-local",
                "--source",
                str(tmp_path / "src"),
                "--out",
                str(out),
                "--run-id",
                "r2",
                "--key-hex",
                TEST_KEY_HEX,
                "--allow-test-key",
                "--production",
                "--phases",
                "work",
            ]
        )
