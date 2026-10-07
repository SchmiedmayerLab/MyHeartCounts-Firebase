# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Generate mhc_export/schemas/healthkit-types.json from the grove-fhir catalogs.

Usage: uv run python scripts/gen_registry.py /path/to/grove-fhir [--ref origin/main]
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

# Measurements Grove admits through an authoritative FHIR profile instead of a Mobile measurement row
# (adapter "standardAdapterClaims"); the unit and code come from that standard profile.
STANDARD_CLAIMS: dict[str, dict] = {
    "body-mass-index": {
        "measurement_id": "body-mass-index",
        "profile": "http://hl7.org/fhir/StructureDefinition/bmi",
        "value_kind": "quantity",
        "unit": "kg/m2",
        "integer_only": False,
        "effective": "dateTime",
        "allowed_values": None,
        "code": {"system": "http://loinc.org", "code": "39156-5"},
    },
}


def git_show(repo: Path, ref: str, path: str) -> dict:
    out = subprocess.check_output(["git", "-C", str(repo), "show", f"{ref}:{path}"])
    return json.loads(out)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("grove_repo", type=Path)
    parser.add_argument("--ref", default="origin/main")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "mhc_export" / "schemas" / "healthkit-types.json",
    )
    args = parser.parse_args()

    adapter = git_show(args.grove_repo, args.ref, "catalog/healthkit-adapter.json")
    catalog = git_show(args.grove_repo, args.ref, "catalog/measurement-catalog.json")
    measurements = {m["id"]: m for m in catalog["measurements"]}
    commit = (
        subprocess.check_output(["git", "-C", str(args.grove_repo), "rev-parse", "--short", args.ref]).decode().strip()
    )

    types: dict[str, dict] = {}
    for row in adapter["rows"]:
        entry: dict = {"status": row["status"], "title": row["title"]}
        mids = row.get("measurementIDs", [])
        if len(mids) == 1 and mids[0] in measurements:
            m = measurements[mids[0]]
            quantity = m.get("quantity") or {}
            domain = quantity.get("valueDomain") or {}
            entry.update(
                measurement_id=mids[0],
                profile=m["profile"],
                value_kind=m["valueKind"],
                unit=quantity.get("code"),
                integer_only=bool(domain.get("integerOnly")),
                minimum=domain.get("minimum"),
                maximum=domain.get("maximum"),
                effective=m["effective"],
                allowed_values=m.get("allowedValues"),
                code={"system": m["code"]["system"], "code": m["code"]["code"]},
            )
        elif mids and mids[0] in STANDARD_CLAIMS:
            entry.update(STANDARD_CLAIMS[mids[0]])
        elif mids:
            entry.update(measurement_id=mids[0], value_kind="unmodeled", measurement_ids=mids)
        types[row["sourceTypeIdentifier"]] = entry

    out = {
        "generated_from": {"repo": "SchmiedmayerLab/grove-fhir", "ref": args.ref, "commit": commit},
        "grove_version": adapter["version"],
        "fhir_version": adapter["fhirVersion"],
        "types": dict(sorted(types.items())),
    }
    args.out.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {args.out} with {len(types)} types from grove {adapter['version']} @ {commit}")


if __name__ == "__main__":
    main()
