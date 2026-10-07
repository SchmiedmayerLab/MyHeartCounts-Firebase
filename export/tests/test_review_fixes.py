# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import json
from pathlib import Path

import orjson
import pytest
import zstandard

from mhc_export.cli import build_parser, main
from mhc_export.config import DEFAULT_DEPLOYMENT_ROOT, IdentityConfig
from mhc_export.grove.view import _decimal_text, parse_observation
from mhc_export.identity.grove_ids import GroveKey, HealthKitIdentity, RepositoryScope
from mhc_export.identity.participants import LocalParticipantLookup
from mhc_export.io.blobstore import LocalBlobStore, ObjectInfo, RoutedStore, sync_prefix
from mhc_export.run.compact import compact_run
from mhc_export.run.envelope import RunEnvelope
from mhc_export.run.inputs import RunInputs, gather_inputs
from mhc_export.run.promote import PromoteConflict, promote_run
from mhc_export.run.unit import Deps, process_unit, unit_sidecar_uri
from mhc_export.run.validate import validate_run
from mhc_export.sources.bucket import plan_units
from mhc_export.transform.project import ProjectContext, ProjectError, project
from mhc_export.transform.specs import default_registry
from tests.conftest import TEST_KEY, pre_grove_heart_rate
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
ROLE = "https://grovealliance.org/fhir/mobile/CodeSystem/grove-identifier-role"
WRITER_VERSION = "https://grovealliance.org/fhir/mobile/StructureDefinition/grove-writer-record-version"
REG = default_registry()


def _zstd(data: bytes) -> bytes:
    return zstandard.ZstdCompressor(write_content_size=False).compress(data)


def grove_hr(
    ident: HealthKitIdentity, uuid: str, *, writer: tuple[str, str] | None = None, version: str | None = None
) -> dict:
    ids = [
        {
            "type": {"coding": [{"system": ROLE, "code": "source-record"}]},
            "system": ident.system("source-record"),
            "value": ident.source_record(HR, uuid),
        },
        {
            "type": {"coding": [{"system": ROLE, "code": "source-output"}]},
            "system": ident.system("source-output"),
            "value": ident.source_output(HR, uuid, "heart-rate"),
        },
    ]
    if writer:
        ids.append(
            {"type": {"coding": [{"system": ROLE, "code": "writer-record"}]}, "system": writer[0], "value": writer[1]}
        )
    ext = [
        {"url": "https://grovealliance.org/fhir/healthkit/StructureDefinition/healthkit-source-type", "valueCode": HR}
    ]
    if version is not None:
        ext.append({"url": WRITER_VERSION, "valueString": version})
    return {
        "resourceType": "Observation",
        "status": "final",
        "identifier": ids,
        "extension": ext,
        "effectiveDateTime": "2025-12-10T10:00:00.000+01:00",
        "valueQuantity": {"value": 61, "unit": "beats/minute", "code": "/min", "system": "http://unitsofmeasure.org"},
    }


def _ctx(config: IdentityConfig, participant: str = "p1") -> ProjectContext:
    ident = config.for_participant(participant)
    from mhc_export.run.models import UploadKind

    return ProjectContext(participant, ident, "r1", UploadKind.LIVE, True, config=config)


def test_run_with_only_foreign_identities_never_promotes(tmp_path: Path) -> None:
    """A key mismatch between migration and export must not produce an empty, validated, promoted run."""
    src = tmp_path / "src"
    migrator = HealthKitIdentity(
        GroveKey(TEST_KEY.secret, "migrator", 1), RepositoryScope("https://x/store", "p"), DEFAULT_DEPLOYMENT_ROOT
    )
    batch = src / "u1" / "2025" / "12" / HR
    batch.mkdir(parents=True)
    (batch / "b1.json.zstd").write_bytes(
        _zstd(orjson.dumps([grove_hr(migrator, f"{i:08x}-0000-4000-8000-000000000000") for i in range(3)]))
    )
    out = tmp_path / "out"
    base = [
        "run-local",
        "--source",
        str(src),
        "--out",
        str(out),
        "--key-hex",
        TEST_KEY_HEX,
        "--allow-test-key",
        "--batch-end",
        "2026-01-01T00:00:00Z",
    ]
    assert main([*base, "--run-id", "r1"]) == 1  # fail closed: the unit errors
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    assert "foreign_identity" in report["units"][f"u1:{HR}"]["error"]
    assert (
        main([*base, "--run-id", "r2", "--tolerate-fatal", "3"]) == 2
    )  # tolerated, but nothing exported: validation fails
    validation = json.loads((out / "runs" / "r2" / "validation.json").read_text())
    assert any("exported none" in c["detail"] for c in validation["checks"] if not c["ok"])
    assert not (out / "lake" / "_current.json").exists()


def test_malformed_grove_identity_is_rejected_per_record() -> None:
    config = IdentityConfig(TEST_KEY)
    ctx = _ctx(config)
    obs = grove_hr(ctx.identity, "11111111-0000-4000-8000-000000000000")
    obs["identifier"][1]["value"] = "v0:test-key:1:not-a-digest"
    with pytest.raises(ProjectError) as exc:
        project(parse_observation(obs), REG.get(HR), ctx, 1)
    assert exc.value.reason == "bad_grove_identity"


@pytest.mark.parametrize("version", ["007", "-1", "1.5", " 3", "v2"])
def test_non_canonical_writer_version_is_rejected(version: str) -> None:
    config = IdentityConfig(TEST_KEY)
    ctx = _ctx(config)
    writer = (ctx.identity.system("writer-record"), "v0:test-key:1:" + "W" * 43)
    obs = grove_hr(ctx.identity, "22222222-0000-4000-8000-000000000000", writer=writer, version=version)
    with pytest.raises(ProjectError) as exc:
        project(parse_observation(obs), REG.get(HR), ctx, 1)
    assert exc.value.reason == "bad_writer_version"
    good = grove_hr(ctx.identity, "22222222-0000-4000-8000-000000000000", writer=writer, version="12")
    assert project(parse_observation(good), REG.get(HR), ctx, 1).row["writer_version"] == "12"
    half = grove_hr(ctx.identity, "22222222-0000-4000-8000-000000000000", version="12")
    with pytest.raises(ProjectError, match="pair"):
        project(parse_observation(half), REG.get(HR), ctx, 1)


def test_legacy_decimal_text_rejects_negatives() -> None:
    assert _decimal_text(-1) is None and _decimal_text(-1.0) is None and _decimal_text("-3") is None
    assert _decimal_text(3) == "3" and _decimal_text("0007") == "7"


def test_legacy_percent_is_scaled_to_percentage_points(ctx: ProjectContext) -> None:
    sat = REG.get("HKQuantityTypeIdentifierOxygenSaturation")
    res = pre_grove_heart_rate(
        code={
            "coding": [
                {
                    "system": "http://developer.apple.com/documentation/healthkit",
                    "code": "HKQuantityTypeIdentifierOxygenSaturation",
                }
            ]
        },
        valueQuantity={"value": 0.97, "unit": "%", "code": "%", "system": "http://unitsofmeasure.org"},
    )
    assert project(parse_observation(res), sat, ctx, 1).row["value"] == pytest.approx(97.0)
    res["valueQuantity"]["value"] = 1e307  # overflows to inf after scaling
    with pytest.raises(ProjectError) as exc:
        project(parse_observation(res), sat, ctx, 1)
    assert exc.value.reason == "non_finite_value"


def test_grove_percent_is_taken_as_points() -> None:
    config = IdentityConfig(TEST_KEY)
    ctx = _ctx(config)
    sat_type = "HKQuantityTypeIdentifierOxygenSaturation"
    obs = grove_hr(ctx.identity, "33333333-0000-4000-8000-000000000000")
    obs["extension"][0]["valueCode"] = sat_type
    obs["identifier"][0]["value"] = ctx.identity.source_record(sat_type, "33333333-0000-4000-8000-000000000000")
    obs["identifier"][1]["value"] = ctx.identity.source_output(
        sat_type, "33333333-0000-4000-8000-000000000000", "oxygen-saturation"
    )
    obs["valueQuantity"] = {"value": 97, "unit": "%", "code": "%", "system": "http://unitsofmeasure.org"}
    assert project(parse_observation(obs), REG.get(sat_type), ctx, 1).row["value"] == 97.0


def test_accept_epoch_is_parsed_strictly() -> None:
    for bad in ("prod", "prod:0", ":1", "prod:x", "a:b:-1"):
        with pytest.raises(SystemExit):
            main(
                [
                    "run-local",
                    "--source",
                    "/nonexistent",
                    "--out",
                    "/tmp/x",
                    "--run-id",
                    "r",
                    "--key-hex",
                    TEST_KEY_HEX,
                    "--allow-test-key",
                    "--accept-epoch",
                    bad,
                ]
            )
    config = IdentityConfig(GroveKey(TEST_KEY.secret, "prod", 2), accepted_epochs=(("prod", 1),))
    assert (
        config.accepted_prefixes() == ("v0:prod:2:", "v0:prod:1:")
        and config.accepted_prefixes() is config.accepted_prefixes()
    )


def test_promote_requires_state_and_refuses_overlap(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        build_parser().parse_args(
            [
                "promote",
                "--compacted",
                "c",
                "--lake",
                "gs://lake",
                "--run-id",
                "r",
                "--validation",
                "v",
                "--report",
                "r",
            ]
        )
    base = [
        "promote",
        "--compacted",
        str(tmp_path / "c"),
        "--run-id",
        "r",
        "--validation",
        str(tmp_path / "state" / "v.json"),
        "--report",
        str(tmp_path / "state" / "r.json"),
        "--envelope",
        str(tmp_path / "state" / "run.json"),
    ]
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "v.json").write_text("{}")
    (tmp_path / "state" / "r.json").write_text("{}")
    with pytest.raises(SystemExit, match="overlaps"):
        main([*base, "--state", str(tmp_path / "state"), "--lake", str(tmp_path / "state" / "lake")])
    with pytest.raises(SystemExit, match="overlaps"):
        main(
            [
                *base,
                "--state",
                "gs://shared/state",
                "--lake",
                "gs://shared/lake",
                "--validation",
                "gs://shared/state/v.json",
                "--report",
                "gs://shared/state/r.json",
            ]
        )


def _deps(tmp_path: Path, src: Path, store, **kw) -> Deps:
    return Deps(
        store=RoutedStore(LocalBlobStore(src), store),
        registry=REG,
        identity=IdentityConfig(TEST_KEY),
        participants=LocalParticipantLookup(tmp_path / "p.json"),
        staging_prefix="staging/r1",
        run_id="r1",
        **kw,
    )


def test_sidecar_intent_survives_a_crash_between_part_writes(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    out = LocalBlobStore(tmp_path / "out")

    class CrashAfterFirstPart(LocalBlobStore):
        writes = 0

        def write(self, uri, data, *, overwrite, metadata=None):
            if uri.endswith(".parquet"):
                CrashAfterFirstPart.writes += 1
                if CrashAfterFirstPart.writes == 2:
                    raise RuntimeError("preempted")
            super().write(uri, data, overwrite=overwrite, metadata=metadata)

    crashing = CrashAfterFirstPart(tmp_path / "out")
    unit = plan_units(LocalBlobStore(src).list(""), sample_types={HR})[0]
    with pytest.raises(RuntimeError, match="preempted"):
        process_unit(unit, _deps(tmp_path, src, crashing))
    sidecar = json.loads(out.read(unit_sidecar_uri("staging/r1", unit)))
    sidecar["parts"] = [p for p in sidecar["parts"] if "/_ledger/" not in p]
    assert len(sidecar["parts"]) == 2  # both planned parts recorded before any write
    written = [p for p in sidecar["parts"] if out.exists(p)]
    assert len(written) == 1
    # the redo yields only the month that was not written; the other month's part must go
    (src / "users" / UID / "liveHealthSamples" / "HKQuantityTypeIdentifierHeartRate_B.json.zstd").unlink()
    unit2 = plan_units(LocalBlobStore(src).list(""), sample_types={HR})[0]
    result = process_unit(unit2, _deps(tmp_path, src, out))
    leftovers = [p for p in sidecar["parts"] if p not in result.parts and out.exists(p)]
    assert not leftovers
    final = json.loads(out.read(unit_sidecar_uri("staging/r1", unit)))["parts"]
    assert [p for p in final if "/_ledger/" not in p] == result.parts


def test_max_unit_rows_flag_fails_the_unit_early(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
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
            "--max-unit-rows",
            "2",
        ]
    )
    assert rc == 1
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())
    assert "passed the cap of 2 rows" in report["units"][f"{UID}:{HR}"]["error"]
    assert report["report"]["max_unit_rows"] == 2


def test_sync_prefix_removes_untracked_local_files(tmp_path: Path) -> None:
    class Store:
        def list(self, prefix):
            yield ObjectInfo("gs://b/s/T/year=2026/month=01/u.parquet", 4, 1, None, {})

        def read(self, uri, generation=None):
            return b"aaaa"

    local = tmp_path / "w"
    stray = local / "T" / "year=2025" / "month=12" / "old.parquet"
    stray.parent.mkdir(parents=True)
    stray.write_bytes(b"stale")
    sync_prefix(Store(), "gs://b/s", local)
    assert not stray.exists() and (local / "T" / "year=2026" / "month=01" / "u.parquet").exists()


def test_promote_treats_missing_checksums_as_conflicts(tmp_path: Path) -> None:
    src = tmp_path / "src"
    build_source(src)
    out = tmp_path / "out"
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
    compacted = out / "compacted" / "r1"
    validation = json.loads((out / "runs" / "r1" / "validation.json").read_text())
    report = json.loads((out / "runs" / "r1" / "report.json").read_text())

    class NoMd5(LocalBlobStore):
        def md5(self, uri):
            return None

    with pytest.raises(PromoteConflict, match="differs from the validated file"):
        promote_run(
            compacted,
            NoMd5(tmp_path / "lake1"),
            "",
            run_id="r1",
            envelope=RunEnvelope.model_validate_json((out / "runs" / "r1" / "run.json").read_text()),
            validation=validation,
            run_report=report,
        )

    class Corrupting(LocalBlobStore):
        def md5(self, uri):
            return "0" * 32

    with pytest.raises(PromoteConflict, match="differs from the validated file"):
        promote_run(
            compacted,
            Corrupting(tmp_path / "lake2"),
            "",
            run_id="r1",
            envelope=RunEnvelope.model_validate_json((out / "runs" / "r1" / "run.json").read_text()),
            validation=validation,
            run_report=report,
        )
    stripped = dict(validation, entries=[{k: v for k, v in e.items() if k != "md5"} for e in validation["entries"]])
    with pytest.raises(PromoteConflict):
        promote_run(
            compacted,
            LocalBlobStore(tmp_path / "lake3"),
            "",
            run_id="r1",
            envelope=RunEnvelope.model_validate_json((out / "runs" / "r1" / "run.json").read_text()),
            validation=stripped,
            run_report=report,
        )
    assert _validate(compacted, report, run_id="r1", uids={UID}).ok
