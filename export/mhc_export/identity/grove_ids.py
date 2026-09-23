# This source file is part of the MyHeart Counts project
#
# SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
# SPDX-License-Identifier: MIT

"""Grove opaque identities, see grove-fhir catalog/exchange-protocol.json#opaqueIdentity."""

from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

DOMAIN = "org.grovealliance.fhir.identity.v0"
PROTOCOL_VERSION = 0

KIND_ARITY: dict[str, int] = {
    "source-record": 5,
    "source-output": 7,
    "writer-record": 3,
    "provider-record": 5,
    "provider-output": 7,
    "source-artifact": 7,
    "provider-artifact": 7,
    "source-context": 5,
    "recording-device": 4,
    "device-snapshot": 4,
}

GROVE_TEST_KEY = bytes(range(32))


class IdentityError(ValueError):
    pass


@dataclass(frozen=True)
class GroveKey:
    secret: bytes
    key_id: str
    epoch: int

    def __post_init__(self) -> None:
        if len(self.secret) < 32:
            raise IdentityError("key must be at least 32 bytes")
        if not self.key_id or ":" in self.key_id:
            raise IdentityError("key id must be non-empty and must not contain ':'")
        if self.epoch < 1:
            raise IdentityError("key epoch must be positive")

    @property
    def is_test_key(self) -> bool:
        return hmac.compare_digest(self.secret, GROVE_TEST_KEY)


def frame(fields: Sequence[str]) -> bytes:
    out = bytearray()
    for field in fields:
        if not isinstance(field, str) or not field:
            raise IdentityError("identity components must be non-empty strings")
        try:
            encoded = field.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise IdentityError("identity components must be Unicode scalar strings") from exc
        out += struct.pack(">I", len(encoded)) + encoded
    return bytes(out)


def opaque_identity(key: GroveKey, kind: str, components: Sequence[str]) -> str:
    arity = KIND_ARITY.get(kind)
    if arity is None:
        raise IdentityError(f"unknown identity kind {kind!r}")
    if len(components) != arity:
        raise IdentityError(f"{kind} needs {arity} components, got {len(components)}")
    digest = hmac.new(key.secret, frame([DOMAIN, kind, *components]), hashlib.sha256).digest()
    encoded = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return f"v0:{key.key_id}:{key.epoch}:{encoded}"


def identifier_system(deployment_root: str, kind: str, key: GroveKey) -> str:
    return f"{deployment_root.rstrip('/')}/NamingSystem/grove-{kind}-v0/{key.key_id}/{key.epoch}"


def canonical_uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise IdentityError(f"not a UUID: {value!r}") from exc


@dataclass(frozen=True)
class RepositoryScope:
    system: str
    value: str


class HealthKitIdentity:
    ADAPTER_ID = "healthkit"

    def __init__(self, key: GroveKey, scope: RepositoryScope, deployment_root: str) -> None:
        self.key = key
        self.scope = scope
        self.deployment_root = deployment_root

    def source_record(self, hk_type: str, native_uuid: str) -> str:
        return opaque_identity(
            self.key,
            "source-record",
            [self.ADAPTER_ID, hk_type, self.scope.system, self.scope.value, canonical_uuid(native_uuid)],
        )

    def source_output(self, hk_type: str, native_uuid: str, output_role: str, discriminator: str = "single") -> str:
        return opaque_identity(
            self.key,
            "source-output",
            [
                self.ADAPTER_ID,
                hk_type,
                self.scope.system,
                self.scope.value,
                canonical_uuid(native_uuid),
                output_role,
                discriminator,
            ],
        )

    def system(self, kind: str) -> str:
        return identifier_system(self.deployment_root, kind, self.key)
