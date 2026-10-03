# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from pathlib import Path

from mhc_export.config import IdentityConfig
from mhc_export.identity.participants import LocalParticipantLookup
from mhc_export.io.blobstore import LocalBlobStore
from mhc_export.run.unit import Deps, process_unit
from mhc_export.sources.bucket import plan_units
from mhc_export.sources.firestore import StaticObservationSource, UserFlags, collection_path
from mhc_export.transform.specs import default_registry
from tests.conftest import TEST_KEY, pre_grove_heart_rate
from tests.test_unit_e2e import UID, build_source


def test_firestore_docs_are_merged_and_win_over_archive(tmp_path: Path) -> None:
    build_source(tmp_path)
    store = LocalBlobStore(tmp_path)
    units = plan_units(store.list(""), sample_types={"HKQuantityTypeIdentifierHeartRate"}, with_firestore=True)
    unit = units[0]
    assert unit.firestore_collection == collection_path(UID, "HKQuantityTypeIdentifierHeartRate")
    reads: list[tuple[str, str]] = []
    # same uuid as historical sample 0 but a different value: the Firestore copy must win
    doc = pre_grove_heart_rate(
        id="00000000-0000-4000-8000-000000000000", identifier=[], effectiveDateTime="2025-12-10T10:00:00+01:00"
    )
    doc["valueQuantity"]["value"] = 123
    new_doc = pre_grove_heart_rate(
        id="77777777-0000-4000-8000-000000000000", identifier=[], effectiveDateTime="2025-12-20T10:00:00+01:00"
    )
    source = StaticObservationSource(
        docs={(UID, "HKQuantityTypeIdentifierHeartRate"): [doc, new_doc]},
        flags={UID: UserFlags(UID, True, False, "complete", "Europe/Berlin")},
        on_read=lambda u, t: reads.append((u, t)),
    )
    deps = Deps(
        store=store,
        registry=default_registry(),
        identity=IdentityConfig(TEST_KEY),
        participants=LocalParticipantLookup(tmp_path / "p.json"),
        staging_prefix="staging/t",
        run_id="t",
        firestore=source,
    )
    result = process_unit(unit, deps)
    assert reads == [(UID, "HKQuantityTypeIdentifierHeartRate")]
    assert result.rows_in == 11 and result.rows_out == 6 and result.dedup_removed == 2
    import pyarrow.parquet as pq

    table = pq.read_table(tmp_path / result.parts[0])
    rows = {r["effective_start"].isoformat(): r for r in table.to_pylist()}
    winner = rows["2025-12-10T09:00:00+00:00"]
    assert winner["value"] == 123.0 and winner["from_archive"] is False
    assert source.user_flags(UID).eligible and source.user_flags("nobody").eligible
