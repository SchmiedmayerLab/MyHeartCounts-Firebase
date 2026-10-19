# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""manifest.jsonl: one Unit per line, written once by plan, read by every worker."""

from __future__ import annotations

from mhc_export.run.models import Unit


def dump_manifest(units: list[Unit]) -> bytes:
    return "".join(unit.model_dump_json() + "\n" for unit in units).encode("utf-8")


def load_manifest(data: bytes) -> list[Unit]:
    return [Unit.model_validate_json(line) for line in data.decode("utf-8").splitlines() if line.strip()]
