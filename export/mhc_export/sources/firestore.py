# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Firestore as a second source: users/{uid}/HealthObservations_{sampleType} documents and user flags."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any, Protocol

WITHDRAWN_FLAG = "hasWithdrawnFromStudy"
HISTORICAL_STATE = "historicalUploadState"


@dataclass(frozen=True)
class UserFlags:
    uid: str
    exists: bool
    withdrawn: bool
    historical_state: str | None
    time_zone: str | None

    @property
    def eligible(self) -> bool:
        return self.exists and not self.withdrawn


class ObservationSource(Protocol):
    def observations(self, uid: str, sample_type: str) -> Iterator[dict[str, Any]]: ...
    def user_flags(self, uid: str) -> UserFlags: ...


def collection_path(uid: str, sample_type: str) -> str:
    return f"users/{uid}/HealthObservations_{sample_type}"


class FirestoreSource:
    def __init__(self, project: str | None = None, client: Any | None = None) -> None:
        if client is None:
            from google.cloud import firestore

            client = firestore.Client(project=project)
        self._client = client

    def observations(self, uid: str, sample_type: str) -> Iterator[dict[str, Any]]:
        for snap in self._client.collection(collection_path(uid, sample_type)).stream():
            data = snap.to_dict() or {}
            data.setdefault("id", snap.id)
            yield data

    def user_flags(self, uid: str) -> UserFlags:
        snap = self._client.collection("users").document(uid).get()
        data = snap.to_dict() or {} if snap.exists else {}
        return UserFlags(
            uid=uid,
            exists=bool(snap.exists),
            withdrawn=bool(data.get(WITHDRAWN_FLAG)),
            historical_state=data.get(HISTORICAL_STATE),
            time_zone=data.get("timeZone"),
        )


class StaticObservationSource:
    """In-memory stand-in for tests and local runs."""

    def __init__(
        self,
        docs: dict[tuple[str, str], list[dict[str, Any]]] | None = None,
        flags: dict[str, UserFlags] | None = None,
        on_read: Callable[[str, str], None] | None = None,
    ) -> None:
        self._docs = docs or {}
        self._flags = flags or {}
        self._on_read = on_read

    def observations(self, uid: str, sample_type: str) -> Iterator[dict[str, Any]]:
        if self._on_read:
            self._on_read(uid, sample_type)
        yield from self._docs.get((uid, sample_type), [])

    def user_flags(self, uid: str) -> UserFlags:
        return self._flags.get(uid, UserFlags(uid, True, False, None, None))
