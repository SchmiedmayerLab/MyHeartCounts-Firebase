# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

import pytest

from mhc_export.transform.timeparse import TimeParseError, parse_instant, zone_matches_offset


def test_parse_instant_offsets_and_rounding() -> None:
    assert parse_instant("2026-01-01T00:00:00Z") == (1767225600000, 0)
    assert parse_instant("2026-01-01T02:00:00+02:00") == (1767225600000, 120)
    assert parse_instant("2025-12-31T16:00:00-08:00") == (1767225600000, -480)
    assert parse_instant("2026-01-01T00:00:00.0004999Z")[0] == 1767225600000
    assert parse_instant("2026-01-01T00:00:00.0005001Z")[0] == 1767225600001
    assert parse_instant("2026-01-01T00:00:00.0005Z")[0] == 1767225600000  # tie to even (0)
    assert parse_instant("2026-01-01T00:00:00.0015Z")[0] == 1767225600002  # tie to even (2)
    assert parse_instant("2026-01-01T00:00:00.123456789123456Z")[0] == 1767225600123
    assert parse_instant("2026-01-01T00:00+05:30") == (1767205800000, 330)


def test_parse_instant_rejects() -> None:
    for bad in ("2026-01-01", "2026-01-01T00:00:00", "nope", "", "2026-13-01T00:00:00Z"):
        with pytest.raises(TimeParseError):
            parse_instant(bad)


def test_zone_matches_offset() -> None:
    summer = parse_instant("2026-07-01T12:00:00+02:00")[0]
    assert zone_matches_offset("Europe/Berlin", summer, 120)
    assert not zone_matches_offset("Europe/Berlin", summer, 60)
    assert not zone_matches_offset("America/Los_Angeles", summer, 120)
    assert not zone_matches_offset("Not/AZone", summer, 120)
    assert not zone_matches_offset(None, summer, 120)
