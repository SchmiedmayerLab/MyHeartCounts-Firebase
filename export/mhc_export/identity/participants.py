# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""uid -> participant_id lookup. Created on first sight, stable forever, never exported."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Protocol


class ParticipantLookup(Protocol):
    def get_or_create(self, uid: str) -> str: ...


class LocalParticipantLookup:
    """JSON file for local runs and tests."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._map: dict[str, str] = json.loads(path.read_text()) if path.exists() else {}

    def get_or_create(self, uid: str) -> str:
        if uid not in self._map:
            self._map[uid] = str(uuid.uuid4())
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._map, indent=1, sort_keys=True))
            tmp.replace(self.path)
        return self._map[uid]


class FirestoreParticipantLookup:
    """Collection in the private project; document id = uid, field participant_id. Creation is transactional."""

    def __init__(self, collection: str = "exportParticipants", project: str | None = None) -> None:
        from google.cloud import firestore

        self._client = firestore.Client(project=project)
        self._collection = self._client.collection(collection)
        self._cache: dict[str, str] = {}

    def get_or_create(self, uid: str) -> str:
        if uid in self._cache:
            return self._cache[uid]
        from google.cloud import firestore

        ref = self._collection.document(uid)
        transaction = self._client.transaction()

        @firestore.transactional
        def _txn(txn: firestore.Transaction) -> str:
            snap = ref.get(transaction=txn)
            if snap.exists:
                return str(snap.get("participant_id"))
            participant_id = str(uuid.uuid4())
            txn.set(ref, {"participant_id": participant_id, "created_at": firestore.SERVER_TIMESTAMP})
            return participant_id

        self._cache[uid] = _txn(transaction)
        return self._cache[uid]
