# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Unit leases: many workers share one manifest, each unit is processed by one live worker at a time.

A unit document holds its state, the current lease (owner, token, expiry), the attempt count and, once done, its
result. A worker claims a pending unit, or one whose lease expired, renews the lease while it works, and completes
the unit with its token. A token is issued per claim, so a worker that lost its lease (for example a preempted VM
that comes back) cannot complete or fail a unit someone else now holds. Units of the participant a worker processed
last are preferred, so one machine tends to handle all of a participant's units.
"""

from __future__ import annotations

import fcntl
import json
import uuid
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

PENDING, LEASED, DONE, FAILED = "pending", "leased", "done", "failed"


class LeaseLost(RuntimeError):
    pass


@dataclass
class UnitLease:
    unit_id: str
    state: str = PENDING
    owner: str | None = None
    token: str | None = None
    expires_at: datetime | None = None
    attempts: int = 0
    result: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)

    def to_doc(self) -> dict[str, Any]:
        return {
            "unit_id": self.unit_id,
            "state": self.state,
            "owner": self.owner,
            "token": self.token,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "attempts": self.attempts,
            "result": self.result,
            "errors": self.errors,
        }

    @classmethod
    def from_doc(cls, doc: dict[str, Any]) -> UnitLease:
        expires = doc.get("expires_at")
        if isinstance(expires, str):
            expires = datetime.fromisoformat(expires)
        return cls(
            unit_id=doc["unit_id"],
            state=doc.get("state", PENDING),
            owner=doc.get("owner"),
            token=doc.get("token"),
            expires_at=expires,
            attempts=int(doc.get("attempts", 0)),
            result=doc.get("result"),
            errors=list(doc.get("errors") or []),
        )

    def claimable(self, now: datetime) -> bool:
        return self.state == PENDING or (
            self.state == LEASED and self.expires_at is not None and self.expires_at <= now
        )


def choose(units: Iterable[UnitLease], now: datetime, prefer_uid: str | None) -> UnitLease | None:
    """The next unit to claim: a claimable unit of the preferred participant first, otherwise the lowest unit id."""
    candidates = sorted((u for u in units if u.claimable(now)), key=lambda u: u.unit_id)
    if prefer_uid:
        for unit in candidates:
            if unit.unit_id.split(":", 1)[0] == prefer_uid:
                return unit
    return candidates[0] if candidates else None


def take(unit: UnitLease, owner: str, now: datetime, ttl: timedelta, max_attempts: int) -> UnitLease:
    """Claim a chosen unit. An expired lease counts as a failed attempt; past max_attempts the unit fails."""
    if unit.state == LEASED:
        unit.errors.append(f"lease of {unit.owner} expired")
    unit.attempts += 1
    if unit.attempts > max_attempts:
        unit.state, unit.owner, unit.token, unit.expires_at = FAILED, None, None, None
        return unit
    unit.state, unit.owner, unit.token, unit.expires_at = LEASED, owner, uuid.uuid4().hex, now + ttl
    return unit


class LeaseStore(Protocol):
    def seed(self, unit_ids: list[str]) -> int: ...
    def claim(
        self, owner: str, ttl: timedelta, max_attempts: int, prefer_uid: str | None = None
    ) -> UnitLease | None: ...
    def renew(self, unit_id: str, token: str, ttl: timedelta) -> None: ...
    def complete(self, unit_id: str, token: str, result: dict[str, Any]) -> None: ...
    def fail(self, unit_id: str, token: str, error: str, max_attempts: int) -> None: ...
    def all(self) -> list[UnitLease]: ...


def _now() -> datetime:
    return datetime.now(tz=UTC)


class LocalLeaseStore:
    """One JSON document per unit under a directory, every change under one exclusive file lock."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def _locked(self):
        with (self.root / ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            yield

    def _path(self, unit_id: str) -> Path:
        return self.root / (unit_id.replace(":", "__").replace("/", "_") + ".json")

    def _load(self, unit_id: str) -> UnitLease:
        return UnitLease.from_doc(json.loads(self._path(unit_id).read_text()))

    def _save(self, unit: UnitLease) -> None:
        tmp = self._path(unit.unit_id).with_suffix(".tmp")
        tmp.write_text(json.dumps(unit.to_doc(), sort_keys=True))
        tmp.replace(self._path(unit.unit_id))

    def seed(self, unit_ids: list[str]) -> int:
        created = 0
        with self._locked():
            for unit_id in unit_ids:
                if not self._path(unit_id).exists():
                    self._save(UnitLease(unit_id))
                    created += 1
        return created

    def all(self) -> list[UnitLease]:
        return [UnitLease.from_doc(json.loads(p.read_text())) for p in sorted(self.root.glob("*.json"))]

    def claim(self, owner: str, ttl: timedelta, max_attempts: int, prefer_uid: str | None = None) -> UnitLease | None:
        with self._locked():
            while True:
                now = _now()
                unit = choose(self.all(), now, prefer_uid)
                if unit is None:
                    return None
                take(unit, owner, now, ttl, max_attempts)
                self._save(unit)
                if unit.state == LEASED:
                    return unit

    def _fenced(self, unit_id: str, token: str) -> UnitLease:
        unit = self._load(unit_id)
        if unit.state != LEASED or unit.token != token:
            raise LeaseLost(f"{unit_id}: the lease was lost to another worker")
        return unit

    def renew(self, unit_id: str, token: str, ttl: timedelta) -> None:
        with self._locked():
            unit = self._fenced(unit_id, token)
            unit.expires_at = _now() + ttl
            self._save(unit)

    def complete(self, unit_id: str, token: str, result: dict[str, Any]) -> None:
        with self._locked():
            unit = self._fenced(unit_id, token)
            unit.state, unit.result, unit.owner, unit.token, unit.expires_at = DONE, result, None, None, None
            self._save(unit)

    def fail(self, unit_id: str, token: str, error: str, max_attempts: int) -> None:
        with self._locked():
            unit = self._fenced(unit_id, token)
            unit.errors.append(error)
            unit.state = FAILED if unit.attempts >= max_attempts else PENDING
            unit.owner, unit.token, unit.expires_at = None, None, None
            self._save(unit)


class FirestoreLeaseStore:
    """Unit documents under {collection}/{run_id}/units in the private project; every change in a transaction."""

    def __init__(
        self, run_id: str, project: str | None = None, collection: str = "exportRuns", client: Any = None
    ) -> None:
        if client is None:
            from google.cloud import firestore

            client = firestore.Client(project=project)
        self._client = client
        self._units = client.collection(collection).document(run_id).collection("units")

    @staticmethod
    def _doc_id(unit_id: str) -> str:
        return unit_id.replace("/", "_")

    def seed(self, unit_ids: list[str]) -> int:
        """Create the missing lease documents; workers starting together may race, and losing a race is fine."""
        existing = {snap.id for snap in self._units.select([]).stream()}
        missing = [u for u in unit_ids if self._doc_id(u) not in existing]
        created = 0
        for start in range(0, len(missing), 400):
            created += self._create_all(missing[start : start + 400])
        return created

    def _create_all(self, unit_ids: list[str]) -> int:
        from google.api_core.exceptions import AlreadyExists, Conflict

        batch = self._client.batch()
        for unit_id in unit_ids:
            batch.create(self._units.document(self._doc_id(unit_id)), UnitLease(unit_id).to_doc())
        try:
            batch.commit()
            return len(unit_ids)
        except (AlreadyExists, Conflict):
            created = 0
            for unit_id in unit_ids:
                try:
                    self._units.document(self._doc_id(unit_id)).create(UnitLease(unit_id).to_doc())
                    created += 1
                except (AlreadyExists, Conflict):
                    continue
            return created

    def all(self) -> list[UnitLease]:
        return [UnitLease.from_doc(snap.to_dict()) for snap in self._units.stream()]

    def claim(self, owner: str, ttl: timedelta, max_attempts: int, prefer_uid: str | None = None) -> UnitLease | None:
        from google.cloud import firestore

        while True:
            now = _now()
            candidates = [
                UnitLease.from_doc(s.to_dict())
                for state in (PENDING, LEASED)
                for s in self._units.where("state", "==", state).limit(200).stream()
            ]
            chosen = choose(candidates, now, prefer_uid)
            if chosen is None:
                return None
            ref = self._units.document(self._doc_id(chosen.unit_id))

            @firestore.transactional
            def _claim(txn: Any, ref: Any = ref) -> UnitLease | None:
                unit = UnitLease.from_doc(ref.get(transaction=txn).to_dict())
                if not unit.claimable(_now()):
                    return None  # someone else got it first
                take(unit, owner, _now(), ttl, max_attempts)
                txn.set(ref, unit.to_doc())
                return unit

            unit = _claim(self._client.transaction())
            if unit is not None and unit.state == LEASED:
                return unit

    def _fenced_update(self, unit_id: str, token: str, change: Any) -> None:
        from google.cloud import firestore

        ref = self._units.document(self._doc_id(unit_id))

        @firestore.transactional
        def _update(txn: Any) -> None:
            unit = UnitLease.from_doc(ref.get(transaction=txn).to_dict())
            if unit.state != LEASED or unit.token != token:
                raise LeaseLost(f"{unit_id}: the lease was lost to another worker")
            change(unit)
            txn.set(ref, unit.to_doc())

        _update(self._client.transaction())

    def renew(self, unit_id: str, token: str, ttl: timedelta) -> None:
        self._fenced_update(unit_id, token, lambda u: setattr(u, "expires_at", _now() + ttl))

    def complete(self, unit_id: str, token: str, result: dict[str, Any]) -> None:
        def change(u: UnitLease) -> None:
            u.state, u.result, u.owner, u.token, u.expires_at = DONE, result, None, None, None

        self._fenced_update(unit_id, token, change)

    def fail(self, unit_id: str, token: str, error: str, max_attempts: int) -> None:
        def change(u: UnitLease) -> None:
            u.errors.append(error)
            u.state = FAILED if u.attempts >= max_attempts else PENDING
            u.owner, u.token, u.expires_at = None, None, None

        self._fenced_update(unit_id, token, change)
