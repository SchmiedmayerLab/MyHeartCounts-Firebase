# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from mhc_export.identity.grove_ids import GROVE_TEST_KEY, GroveKey, HealthKitIdentity, IdentityError, RepositoryScope

DEFAULT_DEPLOYMENT_ROOT = "https://myheartcounts.stanford.edu/fhir"
DEFAULT_SCOPE_SYSTEM = "https://myheartcounts.stanford.edu/fhir/NamingSystem/healthkit-store"


@dataclass(frozen=True)
class IdentityConfig:
    key: GroveKey
    deployment_root: str = DEFAULT_DEPLOYMENT_ROOT
    scope_system: str = DEFAULT_SCOPE_SYSTEM

    def for_participant(self, participant_id: str) -> HealthKitIdentity:
        return HealthKitIdentity(self.key, RepositoryScope(self.scope_system, participant_id), self.deployment_root)


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


__all__ = ["GROVE_TEST_KEY", "IdentityConfig", "load_key", "new_key_hex"]
