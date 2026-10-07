# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""FHIR dateTime/instant text -> (UTC epoch milliseconds, offset minutes), Grove rounding rules."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_RE = re.compile(
    r"^(?P<y>\d{4})-(?P<mo>\d{2})-(?P<d>\d{2})"
    r"(?:T(?P<h>\d{2}):(?P<mi>\d{2})(?::(?P<s>\d{2})(?:\.(?P<f>\d+))?)?"
    r"(?P<tz>Z|[+-]\d{2}:\d{2})?)?$"
)


class TimeParseError(ValueError):
    pass


def parse_instant(text: str) -> tuple[int, int | None]:
    """Returns (epoch_ms, utc_offset_min). Fractions round half-even to milliseconds."""
    m = _RE.match(text or "")
    if not m or m.group("h") is None:
        raise TimeParseError(f"not an instant: {text!r}")
    tz = m.group("tz")
    if tz is None:
        raise TimeParseError(f"instant without offset: {text!r}")
    if tz == "Z":
        offset_min = 0
    else:
        sign = 1 if tz[0] == "+" else -1
        hours, minutes = int(tz[1:3]), int(tz[4:6])
        if hours > 14 or minutes > 59 or (hours == 14 and minutes > 0):
            raise TimeParseError(f"impossible offset: {text!r}")
        offset_min = sign * (hours * 60 + minutes)
    try:
        naive = datetime(
            int(m.group("y")),
            int(m.group("mo")),
            int(m.group("d")),
            int(m.group("h")),
            int(m.group("mi")),
            int(m.group("s") or 0),
            tzinfo=UTC,
        )
    except ValueError as exc:
        raise TimeParseError(f"invalid date: {text!r}") from exc
    digits = m.group("f") or ""
    ns = int(digits[:9].ljust(9, "0"))
    beyond = digits[9:].strip("0")  # any nonzero digit past the nanosecond breaks a tie upward
    ms, rem = divmod(ns, 1_000_000)
    if rem > 500_000 or (rem == 500_000 and (beyond or ms % 2 == 1)):
        ms += 1
    epoch_ms = int(naive.timestamp()) * 1000 + ms - offset_min * 60_000
    return epoch_ms, offset_min


@lru_cache(maxsize=256)
def _zone(name: str) -> ZoneInfo | None:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def zone_matches_offset(name: str | None, epoch_ms: int, offset_min: int | None) -> bool:
    """Grove: an IANA name may be attached only when it agrees with the numeric offset at that instant."""
    if not name or offset_min is None:
        return False
    zone = _zone(name)
    if zone is None:
        return False
    at = datetime.fromtimestamp(epoch_ms / 1000, tz=zone).utcoffset()
    return at is not None and int(at.total_seconds()) // 60 == offset_min
