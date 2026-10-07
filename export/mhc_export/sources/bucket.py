# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Classify source objects in either bucket layout and group them into work units."""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime

from mhc_export.io.blobstore import ObjectInfo
from mhc_export.run.models import DataVersion, Layout, SourceObject, Unit, UploadKind
from mhc_export.sources.users import UserFlags

LEGACY_RE = re.compile(
    r"(?:^|/)users/(?P<uid>[^/]+)/(?P<kind>liveHealthSamples|historicalHealthSamples|healthDeletions)/"
    r"(?P<type>[A-Za-z0-9]+)_(?P<uuid>[A-Fa-f0-9-]+)\.(?P<ext>json|csv)(?:\.zstd)?$"
)
V1_RE = re.compile(
    r"(?:^|/)(?P<uid>[^/]+)/(?P<yyyy>\d{4})/(?P<mm>\d{2})/(?P<type>[A-Za-z0-9]+)/(?P<name>[^/]+)\.(?P<ext>json|csv)(?:\.zstd)?$"
)
LEGACY_KINDS = {
    "liveHealthSamples": UploadKind.LIVE,
    "historicalHealthSamples": UploadKind.HISTORICAL,
    "healthDeletions": UploadKind.DELETIONS,
}
META_UPLOAD_KIND = "upload_kind"
META_DATA_VERSION = "data_version"


def classify(info: ObjectInfo) -> tuple[str, str, SourceObject] | None:
    """Returns (uid, sample_type, SourceObject) or None for objects the export does not read."""
    m = LEGACY_RE.search(info.uri)
    if m:
        kind = LEGACY_KINDS[m.group("kind")]
        if (kind == UploadKind.DELETIONS) != (m.group("ext") == "csv"):
            return None
        obj = SourceObject(
            uri=info.uri,
            generation=info.generation,
            size=info.size,
            layout=Layout.LEGACY,
            upload_kind=kind,
            data_version=DataVersion.PRE_GROVE,
            created=info.created,
        )
        return m.group("uid"), m.group("type"), obj
    m = V1_RE.search(info.uri)
    if m:
        kind_text = info.metadata.get(META_UPLOAD_KIND)
        if kind_text not in {k.value for k in UploadKind}:
            kind = UploadKind.DELETIONS if m.group("ext") == "csv" else UploadKind.LIVE
        else:
            kind = UploadKind(kind_text)
        version_text = info.metadata.get(META_DATA_VERSION)
        version = DataVersion(version_text) if version_text in {v.value for v in DataVersion} else DataVersion.PRE_GROVE
        obj = SourceObject(
            uri=info.uri,
            generation=info.generation,
            size=info.size,
            layout=Layout.V1,
            upload_kind=kind,
            data_version=version,
            created=info.created,
        )
        return m.group("uid"), m.group("type"), obj
    return None


def plan_units(
    objects: Iterable[ObjectInfo],
    *,
    uids: set[str] | None = None,
    sample_types: set[str] | None = None,
    batch_start: datetime | None = None,
    batch_end: datetime | None = None,
) -> list[Unit]:
    grouped: dict[tuple[str, str], list[SourceObject]] = defaultdict(list)
    for info in objects:
        hit = classify(info)
        if hit is None:
            continue
        uid, sample_type, obj = hit
        if uids is not None and uid not in uids:
            continue
        if sample_types is not None and sample_type not in sample_types:
            continue
        if obj.created is not None:
            if batch_start is not None and obj.created < batch_start:
                continue
            if batch_end is not None and obj.created >= batch_end:
                continue
        grouped[(uid, sample_type)].append(obj)
    units: list[Unit] = []
    for (uid, sample_type), objs in sorted(grouped.items()):
        objs.sort(key=lambda o: (o.upload_kind != UploadKind.HISTORICAL, o.upload_kind == UploadKind.DELETIONS, o.uri))
        units.append(
            Unit(
                unit_id=Unit.make_id(uid, sample_type),
                uid=uid,
                sample_type=sample_type,
                objects=objs,
                expected_bytes=sum(o.size for o in objs),
            )
        )
    return units


def apply_eligibility(units: list[Unit], flags: dict[str, UserFlags]) -> tuple[list[Unit], dict[str, int], int]:
    """Drops every unit of an ineligible user. Returns (kept units, excluded users per reason, excluded units)."""
    kept: list[Unit] = []
    excluded_users: dict[str, set[str]] = defaultdict(set)
    excluded_units = 0
    for unit in units:
        reason = flags[unit.uid].exclusion_reason if unit.uid in flags else "no_account"
        if reason is None:
            kept.append(unit)
        else:
            excluded_users[reason].add(unit.uid)
            excluded_units += 1
    return kept, {reason: len(uids) for reason, uids in sorted(excluded_users.items())}, excluded_units
