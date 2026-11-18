# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""HealthKit category raw values -> (HealthKit case name, Grove code)."""

from __future__ import annotations

# sample type -> raw HKCategoryValue integer -> (healthkit case, grove code)
CATEGORY_VALUES: dict[str, dict[int, tuple[str, str]]] = {
    "HKCategoryTypeIdentifierSleepAnalysis": {
        0: ("inBed", "in-bed"),
        1: ("asleepUnspecified", "asleep-unspecified"),
        2: ("awake", "awake"),
        3: ("asleepCore", "light"),
        4: ("asleepDeep", "deep"),
        5: ("asleepREM", "rem"),
    },
    "HKCategoryTypeIdentifierAppleStandHour": {
        0: ("stood", "stood"),
        1: ("idle", "idle"),
    },
    "HKCategoryTypeIdentifierLowHeartRateEvent": {0: ("notApplicable", "occurred")},
    "HKCategoryTypeIdentifierHighHeartRateEvent": {0: ("notApplicable", "occurred")},
    "HKCategoryTypeIdentifierIrregularHeartRhythmEvent": {0: ("notApplicable", "occurred")},
}

HEART_RATE_MOTION_CONTEXT: dict[int, str] = {0: "not-set", 1: "sedentary", 2: "active"}


class CategoryValueError(ValueError):
    pass


def category_value(sample_type: str, raw: int | str | None) -> tuple[str, str]:
    table = CATEGORY_VALUES.get(sample_type)
    if table is None:
        raise CategoryValueError(f"no category value mapping for {sample_type}")
    if raw is None:
        if len(table) == 1:
            return next(iter(table.values()))
        raise CategoryValueError(f"{sample_type} requires a category value")
    try:
        key = int(raw)
    except (TypeError, ValueError) as exc:
        raise CategoryValueError(f"{sample_type} category value {raw!r} is not an integer") from exc
    if key not in table:
        raise CategoryValueError(f"{sample_type} category value {key} is not mapped")
    return table[key]
