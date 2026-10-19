# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Regression tests for the review of phases 2 and 3."""

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from mhc_export.cli import main
from mhc_export.config import IdentityConfig
from mhc_export.grove.view import parse_observation
from mhc_export.identity.grove_ids import GroveKey
from mhc_export.identity.participants import LocalParticipantLookup
from mhc_export.io.blobstore import LocalBlobStore
from mhc_export.run.compact import SchemaDrift, compact_partition
from mhc_export.run.envelope import Eligibility, RunEnvelope
from mhc_export.run.inputs import commit_ledger
from mhc_export.run.lake import CurrentPointer, commit, read_current
from mhc_export.run.promote import PromoteConflict, production_run_problems, promote_run
from mhc_export.transform.project import ProjectError, project
from mhc_export.transform.specs import default_registry
from mhc_export.transform.timeparse import zone_matches_offset
from tests.conftest import TEST_KEY, pre_grove_heart_rate
from tests.test_unit_e2e import TEST_KEY_HEX, UID, build_source

HR = "HKQuantityTypeIdentifierHeartRate"
SPEC = default_registry().get(HR)


def test_compaction_refuses_inputs_with_another_column_set(tmp_path: Path) -> None:
    schema = pa.schema([f for f in SPEC.arrow_schema if f.name != "device_firmware"])
    staged = tmp_path / "part.parquet"
    pq.write_table(schema.empty_table(), staged)
    with pytest.raises(SchemaDrift, match="device_firmware"):
        compact_partition(
            (HR, 2025, 12),
            tmp_path / "out",
            SPEC,
            staged=[staged],
            committed=[],
            ledger=[],
            run_id="r1",
            grove_version="0.6.0",
        )


@pytest.mark.parametrize("when", ["1959-12-31T23:00:00+00:00", "2160-01-01T00:00:00+00:00"])
def test_samples_outside_the_partitionable_months_are_dropped(ctx, when: str) -> None:
    with pytest.raises(ProjectError) as exc:
        project(parse_observation(pre_grove_heart_rate(effectiveDateTime=when)), SPEC, ctx, 1)
    assert exc.value.reason == "bad_time"
    assert zone_matches_offset("Europe/Berlin", 10**18, 60) is False


def _envelope(**kw) -> RunEnvelope:
    base = dict(
        run_id="r1",
        batch_start=None,
        batch_end=datetime(2026, 9, 1, tzinfo=UTC),
        window_applied=True,
        scoped=False,
        source="gs://mhc-source",
        manifest_sha256="0" * 64,
        unit_count=3,
        eligibility=Eligibility(source="firestore"),
        grove_version="0.6.0",
        registry_commit="e04ab86",
        package_version="0.1.0",
        created_at=datetime(2026, 9, 1, tzinfo=UTC),
    )
    return RunEnvelope(**{**base, **kw})


PRODUCTION_REPORT = {
    "report": {
        "identity": {"key_source": "secret-manager", "key_id": "prod"},
        "participants_source": "firestore",
        "grove": {"accept_legacy": False},
    }
}


def test_production_promotion_checks_what_the_run_recorded(tmp_path: Path) -> None:
    assert production_run_problems(_envelope(), PRODUCTION_REPORT) == []
    dev = {
        "report": {
            "identity": {"key_source": "file", "key_id": "local"},
            "participants_source": "file",
            "grove": {"accept_legacy": True},
        }
    }
    env = _envelope(source="gs://mhc-source/users/abc", eligibility=Eligibility(source="file"), unit_count=0)
    assert len(production_run_problems(env, dev)) == 7
    with pytest.raises(PromoteConflict, match="gs:// lake"):
        promote_run(
            tmp_path,
            LocalBlobStore(tmp_path),
            "",
            run_id="r1",
            envelope=_envelope(),
            validation={},
            run_report=PRODUCTION_REPORT,
            production=True,
        )


def test_plan_refuses_when_no_listed_user_has_an_account(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    flags = tmp_path / "flags.json"
    flags.write_text("{}")
    manifest = tmp_path / "state" / "manifest.jsonl"
    with pytest.raises(SystemExit, match="none of the 1 listed users"):
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


def test_work_refuses_a_plan_from_another_package_or_registry(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    manifest = tmp_path / "state" / "manifest.jsonl"
    assert (
        main(["plan", "--source", str(src), "--manifest", str(manifest), "--run-id", "r1", "--eligibility", "none"])
        == 0
    )
    envelope_path = tmp_path / "state" / "run.json"
    envelope = json.loads(envelope_path.read_text())
    envelope["registry_sha256"] = "f" * 64
    envelope_path.write_text(json.dumps(envelope))
    work = [
        "work",
        "--manifest",
        str(manifest),
        "--state",
        str(tmp_path / "staging"),
        "--run-id",
        "r1",
        "--participants",
        str(tmp_path / "p.json"),
        "--key-hex",
        TEST_KEY_HEX,
        "--allow-test-key",
        "--accept-legacy",
    ]
    with pytest.raises(SystemExit, match="registry_sha256"):
        main(work)


def test_key_check_tells_secrets_apart_without_revealing_them() -> None:
    a = IdentityConfig(TEST_KEY).describe()
    b = IdentityConfig(GroveKey(bytes(range(1, 33)), TEST_KEY.key_id, TEST_KEY.epoch)).describe()
    assert a["key_check"] != b["key_check"] and len(a["key_check"]) == 16
    assert TEST_KEY.secret.hex() not in json.dumps(a)


def test_participant_lookups_sharing_a_file_agree(tmp_path: Path) -> None:
    path = tmp_path / "p.json"
    first, second = LocalParticipantLookup(path), LocalParticipantLookup(path)
    a = first.get_or_create("uid-a")
    b = second.get_or_create("uid-b")
    assert second.get_or_create("uid-a") == a and LocalParticipantLookup(path).get_or_create("uid-b") == b


def test_commit_ledger_refreshes_a_part_that_changed(tmp_path: Path) -> None:
    state = LocalBlobStore(tmp_path)
    staged = f"staging/r1/_ledger/{HR}/u1__{HR}.parquet"
    state.write(staged, b"one", overwrite=True)
    assert commit_ledger(state, "", "r1") == 1 and commit_ledger(state, "", "r1") == 0
    state.write(staged, b"two", overwrite=True)
    assert commit_ledger(state, "", "r1") == 1
    assert state.read(f"ledger/{HR}/r1__u1__{HR}.parquet") == b"two"


def test_a_retried_pointer_write_that_already_landed_is_not_a_conflict(tmp_path: Path) -> None:
    lake = LocalBlobStore(tmp_path)
    pointer = CurrentPointer(
        run_id="r1",
        batch_end=None,
        dataset="runs/r1/dataset.jsonl",
        dataset_sha256=hashlib.sha256(b"").hexdigest(),
        files=0,
        rows=0,
        committed_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    commit(lake, "", pointer, None)
    commit(lake, "", pointer, None)  # the same write again with the token read before it
    assert read_current(lake, "")[0] == pointer
    with pytest.raises(Exception, match="concurrently"):
        commit(lake, "", pointer.model_copy(update={"run_id": "r2"}), None)


def _lake_rows(out: Path) -> list[tuple]:
    tables = [pq.read_table(p) for p in sorted((out / "lake" / "v1" / HR).rglob("*.parquet"))]
    rows = pa.concat_tables(tables).select(["sample_id", "value", "effective_start"]).to_pylist()
    return sorted((r["sample_id"], r["value"], r["effective_start"]) for r in rows)


def test_sharded_units_export_exactly_what_whole_units_do(tmp_path: Path) -> None:
    from mhc_export.sources.bucket import plan_units

    src = tmp_path / "src"
    build_source(src)
    units = plan_units(LocalBlobStore(src).list(""), sample_types={HR}, max_unit_bytes=1)
    assert [u.unit_id for u in units] == [f"{UID}:{HR}:{n:03d}" for n in range(4)]
    assert units[-1].objects[0].upload_kind.value == "deletions"  # the deletion sits apart from its sample
    outs = {}
    for name, extra in (("whole", []), ("sharded", ["--max-unit-bytes", "1"])):
        out = tmp_path / name
        participants = out / "private" / "participants.json"
        participants.parent.mkdir(parents=True)
        participants.write_text(json.dumps({UID: "p-fixed"}))
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
                *extra,
            ]
        )
        assert rc == 0
        outs[name] = _lake_rows(out)
    assert outs["sharded"] == outs["whole"] and len(outs["whole"]) == 5
