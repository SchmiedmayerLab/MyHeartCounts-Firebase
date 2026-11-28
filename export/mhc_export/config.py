# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from __future__ import annotations

import hashlib
import hmac
import os
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

from mhc_export.identity.grove_ids import (
    GROVE_TEST_KEY,
    GroveKey,
    HealthKitIdentity,
    IdentityError,
    RepositoryScope,
    identifier_system,
)

DEFAULT_DEPLOYMENT_ROOT = "https://myheartcounts.stanford.edu/fhir"
DEFAULT_SCOPE_SYSTEM = "https://myheartcounts.stanford.edu/fhir/NamingSystem/healthkit-store"
DEFAULT_PARTICIPANT_SYSTEM = "https://myheartcounts.stanford.edu/fhir/identifiers/participant"
DEFAULT_NATIVE_RECORD_SYSTEM = "https://myheartcounts.stanford.edu/fhir/identifiers/healthkit-record"
DEFAULT_STUDY_PROTOCOL = "https://myheartcounts.stanford.edu/fhir/PlanDefinition/5d464372-c9a3-4018-a789-47149d934bfc"
# MHC iOS mints its Grove identities on the device under key id "store", epoch 1
DEFAULT_PRODUCER_NAMESPACES: tuple[tuple[str, int], ...] = (("store", 1),)


@dataclass(frozen=True)
class GroveSettings:
    """How Grove exchange events from the app are read. The export does not adopt the producer's opaque
    identities as sample ids: it mints its own from the disclosed HealthKit UUID with the export key, so samples
    match across devices, reinstalls and migrated legacy records."""

    deployment_root: str = DEFAULT_DEPLOYMENT_ROOT
    producer_namespaces: tuple[tuple[str, int], ...] = DEFAULT_PRODUCER_NAMESPACES
    participant_system: str = DEFAULT_PARTICIPANT_SYSTEM
    native_record_system: str = DEFAULT_NATIVE_RECORD_SYSTEM
    study_protocol: str = DEFAULT_STUDY_PROTOCOL
    accept_legacy: bool = False

    def __post_init__(self) -> None:
        for key_id, epoch in self.producer_namespaces:
            if not key_id or epoch < 1:
                raise IdentityError(f"invalid producer namespace {key_id}:{epoch}")

    def describe(self) -> dict[str, object]:
        return {
            "deployment_root": self.deployment_root,
            "producer_namespaces": [f"{k}:{e}" for k, e in self.producer_namespaces],
            "participant_system": self.participant_system,
            "native_record_system": self.native_record_system,
            "study_protocol": self.study_protocol,
            "accept_legacy": self.accept_legacy,
        }


@dataclass(frozen=True)
class IdentityConfig:
    key: GroveKey
    deployment_root: str = DEFAULT_DEPLOYMENT_ROOT
    scope_system: str = DEFAULT_SCOPE_SYSTEM
    key_source: str = "file"
    accepted_epochs: tuple[tuple[str, int], ...] = ()

    def __post_init__(self) -> None:
        for key_id, epoch in self.accepted_epochs:
            GroveKey(self.key.secret, key_id, epoch)  # raises IdentityError on an invalid label

    def for_participant(self, participant_id: str) -> HealthKitIdentity:
        return HealthKitIdentity(self.key, RepositoryScope(self.scope_system, participant_id), self.deployment_root)

    @cached_property
    def epochs(self) -> tuple[tuple[str, int], ...]:
        current = (self.key.key_id, self.key.epoch)
        return (current, *tuple(e for e in self.accepted_epochs if e != current))

    @cached_property
    def _prefixes(self) -> tuple[str, ...]:
        return tuple(f"v0:{key_id}:{epoch}:" for key_id, epoch in self.epochs)

    @cached_property
    def _systems(self) -> dict[str, frozenset[str]]:
        kinds = ("source-record", "source-output", "writer-record")
        return {
            kind: frozenset(
                identifier_system(self.deployment_root, kind, GroveKey(self.key.secret, key_id, epoch))
                for key_id, epoch in self.epochs
            )
            for kind in kinds
        }

    def accepted_prefixes(self) -> tuple[str, ...]:
        return self._prefixes

    def accepted_systems(self, kind: str) -> frozenset[str]:
        return self._systems.get(kind, frozenset())

    def describe(self) -> dict[str, object]:
        """Non-secret identity configuration for run reports."""
        return {
            "key_id": self.key.key_id,
            "key_epoch": self.key.epoch,
            "key_source": self.key_source,
            "scope_system": self.scope_system,
            "deployment_root": self.deployment_root,
            "accepted_epochs": [f"{k}:{e}" for k, e in self.epochs],
            "key_check": self.key_check,
        }

    @cached_property
    def key_check(self) -> str:
        """Non-secret check value: workers with the same key id and epoch but different secrets disagree here."""
        return hmac.new(self.key.secret, b"mhc-export key check v1", hashlib.sha256).hexdigest()[:16]


def load_key_from_secret(secret_version: str, *, key_id: str, epoch: int, project: str | None = None) -> GroveKey:
    """secret_version is projects/P/secrets/S/versions/V; the payload is the hex key."""
    from google.cloud import secretmanager

    client = secretmanager.SecretManagerServiceClient()
    payload = client.access_secret_version(request={"name": secret_version}).payload.data.decode("utf-8").strip()
    key = GroveKey(bytes.fromhex(payload), key_id, epoch)
    if key.is_test_key:
        raise IdentityError("the secret holds the Grove public conformance key")
    return key


def check_production(config: IdentityConfig, *, participants_source: str) -> None:
    problems: list[str] = []
    if config.key_source != "secret-manager":
        problems.append("the key must come from Secret Manager")
    if config.key.key_id == "local":
        problems.append("key id 'local' is not allowed")
    if config.key.is_test_key:
        problems.append("the Grove public conformance key is not allowed")
    if participants_source != "firestore":
        problems.append("the participant lookup must be the Firestore collection")
    if problems:
        raise IdentityError("production mode: " + "; ".join(problems))


def load_key(
    *,
    key_hex: str | None = None,
    key_file: Path | None = None,
    key_id: str = "local",
    epoch: int = 1,
    allow_test_key: bool = False,
) -> GroveKey:
    if key_hex is None and key_file is not None:
        key_hex = key_file.read_text().strip()
    if key_hex is None:
        key_hex = os.environ.get("MHC_EXPORT_KEY_HEX")
    if not key_hex:
        raise IdentityError("no HMAC key: pass --key-hex, --key-file, or MHC_EXPORT_KEY_HEX")
    key = GroveKey(bytes.fromhex(key_hex), key_id, epoch)
    if key.is_test_key and not allow_test_key:
        raise IdentityError("the Grove public conformance key is not allowed outside tests")
    return key


def new_key_hex() -> str:
    return os.urandom(32).hex()


__all__ = [
    "GROVE_TEST_KEY",
    "GroveSettings",
    "IdentityConfig",
    "check_production",
    "load_key",
    "load_key_from_secret",
    "new_key_hex",
]
