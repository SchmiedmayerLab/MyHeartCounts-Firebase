# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Export eligibility from the user documents: who may be exported at plan time."""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

WITHDRAWN = "hasWithdrawnFromStudy"
TO_BE_DELETED = "toBeDeleted"
HISTORICAL_STATE = "historicalUploadState"


@dataclass(frozen=True)
class UserFlags:
    uid: str
    exists: bool
    withdrawn: bool = False
    to_be_deleted: bool = False
    historical_state: str | None = None

    @property
    def exclusion_reason(self) -> str | None:
        """Withdrawn participants and accounts that are gone or being deleted are never exported."""
        if not self.exists:
            return "no_account"
        if self.to_be_deleted:
            return "deletion_requested"
        if self.withdrawn:
            return "withdrawn"
        return None

    @property
    def eligible(self) -> bool:
        return self.exclusion_reason is None

    @classmethod
    def from_document(cls, uid: str, data: dict[str, Any] | None) -> UserFlags:
        if data is None:
            return cls(uid, exists=False)
        state = data.get(HISTORICAL_STATE)
        return cls(
            uid,
            exists=True,
            withdrawn=data.get(WITHDRAWN) is True,
            to_be_deleted=data.get(TO_BE_DELETED) is True,
            historical_state=state if isinstance(state, str) else None,
        )


class UserFlagSource(Protocol):
    name: str

    def flags_for(self, uids: Iterable[str]) -> dict[str, UserFlags]: ...


class FirestoreUserFlags:
    """users/{uid} documents, read in batches."""

    name = "firestore"

    def __init__(self, project: str | None = None, client: Any | None = None, batch_size: int = 300) -> None:
        if client is None:
            from google.cloud import firestore

            client = firestore.Client(project=project)
        self._client = client
        self._batch_size = batch_size

    def flags_for(self, uids: Iterable[str]) -> dict[str, UserFlags]:
        ordered = sorted(set(uids))
        out: dict[str, UserFlags] = {}
        users = self._client.collection("users")
        for start in range(0, len(ordered), self._batch_size):
            refs = [users.document(uid) for uid in ordered[start : start + self._batch_size]]
            for snap in self._client.get_all(refs, field_paths=[WITHDRAWN, TO_BE_DELETED, HISTORICAL_STATE]):
                out[snap.id] = UserFlags.from_document(snap.id, snap.to_dict() if snap.exists else None)
        for uid in ordered:
            out.setdefault(uid, UserFlags(uid, exists=False))
        return out


class FileUserFlags:
    """JSON object {uid: user document fields} for local runs and tests; a uid that is absent has no account."""

    name = "file"

    def __init__(self, path: Path) -> None:
        self._docs: dict[str, dict[str, Any]] = json.loads(path.read_text())

    def flags_for(self, uids: Iterable[str]) -> dict[str, UserFlags]:
        return {uid: UserFlags.from_document(uid, self._docs.get(uid)) for uid in uids}
