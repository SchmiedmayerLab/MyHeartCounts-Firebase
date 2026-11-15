// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Grove exchange identity primitives (grove-fhir 0.8.0
 * `catalog/exchange-protocol.json` → `opaqueIdentity`, `entryIdentity`,
 * `recordVersion`; reference implementation `Scripts/exchange_protocol.py`).
 */

import { createHash, createHmac } from "crypto";
import { canonicalBytes } from "./canonicalJson.js";
import { GroveUrl } from "./constants.js";

const IDENTITY_DOMAIN = "org.grovealliance.fhir.identity.v0";
const RECORD_CONTENT_DOMAIN = "org.grovealliance.fhir.record-content.v0";
const FULL_URL_NAMESPACE = "43df4575-bff7-5a57-9a80-2472cd2b0623";

/** The public conformance key from `testVectors.keyHex`; production must reject it. */
export const GROVE_TEST_KEY_HEX =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** The identity kinds this backend mints (the IG defines more). */
export type IdentityKind =
  | "provider-record"
  | "provider-output"
  | "provider-artifact"
  | "device-snapshot"
  | "record-version";

const COMPONENT_COUNT: Record<IdentityKind, number> = {
  "provider-record": 5,
  "provider-output": 7,
  "provider-artifact": 7,
  "device-snapshot": 4,
  "record-version": 3,
};

export class GroveIdentityError extends Error {
  constructor(readonly code: string) {
    super(`grove identity: ${code}`);
    this.name = "GroveIdentityError";
    Object.setPrototypeOf(this, GroveIdentityError.prototype);
  }
}

/** Unsigned 32-bit big-endian length followed by the UTF-8 bytes, per field. */
export const frameFields = (fields: Array<string | Buffer>): Buffer =>
  Buffer.concat(
    fields.flatMap((field) => {
      const bytes =
        typeof field === "string" ? Buffer.from(field, "utf8") : field;
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );

export const base64urlNoPadding = (bytes: Buffer): string =>
  bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const validateComponents = (kind: IdentityKind, components: string[]): void => {
  if (components.length !== COMPONENT_COUNT[kind]) {
    throw new GroveIdentityError("component-arity");
  }
  if (components.some((component) => component.length === 0)) {
    throw new GroveIdentityError("empty-component");
  }
  if (
    kind === "provider-artifact" &&
    !/^(?:0|[1-9][0-9]*)$/.test(components[6])
  ) {
    throw new GroveIdentityError("non-canonical-part-index");
  }
  const digest =
    kind === "record-version" ? components[2]
    : kind === "device-snapshot" ? components[3]
    : undefined;
  if (digest !== undefined && !DIGEST_PATTERN.test(digest)) {
    throw new GroveIdentityError("non-canonical-digest");
  }
};

/** Secret identity configuration for one deployment key. */
export interface GroveIdentityKey {
  key: Buffer;
  keyId: string;
  epoch: string;
  /** Deployment root, e.g. `https://myheartcounts.stanford.edu/fhir`. */
  root: string;
}

export const assertProductionKey = (key: GroveIdentityKey): void => {
  if (key.key.length < 32) throw new GroveIdentityError("key-too-short");
  if (
    key.key.toString("hex") === GROVE_TEST_KEY_HEX ||
    key.keyId === "test-key"
  ) {
    throw new GroveIdentityError("test-key-prohibited");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(key.keyId)) {
    throw new GroveIdentityError("invalid-key-id");
  }
  if (!/^[1-9][0-9]*$/.test(key.epoch)) {
    throw new GroveIdentityError("invalid-epoch");
  }
};

/** `v0:<keyId>:<epoch>:<base64url HMAC-SHA-256>` over the framed preimage. */
export const deriveIdentityValue = (
  key: Pick<GroveIdentityKey, "key" | "keyId" | "epoch">,
  kind: IdentityKind,
  components: string[],
): string => {
  validateComponents(kind, components);
  const preimage = frameFields([IDENTITY_DOMAIN, kind, ...components]);
  const digest = createHmac("sha256", key.key).update(preimage).digest();
  return `v0:${key.keyId}:${key.epoch}:${base64urlNoPadding(digest)}`;
};

/** Recommended system `<root>/NamingSystem/grove-<kind>-v0/<keyId>/<epoch>`. */
export const identitySystem = (
  key: Pick<GroveIdentityKey, "root" | "keyId" | "epoch">,
  kind: IdentityKind,
): string =>
  `${key.root}/NamingSystem/grove-${kind}-v0/${key.keyId}/${key.epoch}`;

/** Identifier role coding carried in `Identifier.type` for each kind. */
export const IDENTIFIER_ROLE: Record<IdentityKind, string> = {
  "provider-record": "source-record",
  "provider-output": "source-output",
  "provider-artifact": "source-artifact",
  "device-snapshot": "device-snapshot",
  "record-version": "record-version",
};

export interface GroveIdentifier {
  type: { coding: Array<{ system: string; code: string }> };
  system: string;
  value: string;
}

export const typedIdentifier = (
  key: GroveIdentityKey,
  kind: IdentityKind,
  components: string[],
): GroveIdentifier => ({
  type: {
    coding: [{ system: GroveUrl.identifierRole, code: IDENTIFIER_ROLE[kind] }],
  },
  system: identitySystem(key, kind),
  value: deriveIdentityValue(key, kind, components),
});

// --- UUIDv5 fullUrl ------------------------------------------------------------

const uuidBytes = (uuid: string): Buffer =>
  Buffer.from(uuid.replace(/-/g, ""), "hex");

const formatUuid = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** `urn:uuid:` + UUIDv5 over the framed `[system, value]` of the entry key. */
export const entryFullUrl = (system: string, value: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(system)) {
    throw new GroveIdentityError("system-not-absolute");
  }
  if (value.length === 0) throw new GroveIdentityError("empty-value");
  const digest = createHash("sha1")
    .update(uuidBytes(FULL_URL_NAMESPACE))
    .update(frameFields([system, value]))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return `urn:uuid:${formatUuid(Buffer.from(digest))}`;
};

// --- Digests --------------------------------------------------------------------

const sha256Base64url = (bytes: Buffer): string =>
  base64urlNoPadding(createHash("sha256").update(bytes).digest());

type JsonObject = Record<string, unknown>;

const withoutId = (resource: JsonObject): JsonObject => {
  const { id: _ignored, ...rest } = resource;
  return rest;
};

/**
 * Content digest of a shared node (Device): canonical JSON minus `id` and
 * minus its own `device-snapshot` identifier (dropping `identifier` if empty).
 */
export const deviceContentDigest = (device: JsonObject): string => {
  const content = withoutId(device);
  const identifiers =
    (content.identifier as Array<Partial<GroveIdentifier>> | undefined) ?? [];
  const kept = identifiers.filter(
    (identifier) =>
      !identifier.type?.coding.some(
        (coding) =>
          coding.system === GroveUrl.identifierRole &&
          coding.code === "device-snapshot",
      ),
  );
  if (kept.length > 0) content.identifier = kept;
  else delete content.identifier;
  return sha256Base64url(canonicalBytes(content));
};

/**
 * Record-content digest: SHA-256 over the framed
 * `[domain, canonical(P'), canonical(O1), …]`, where P' is the Provenance
 * minus `id` and minus its `grove-record-version` extension.
 */
export const recordContentDigest = (
  provenance: JsonObject,
  outputs: JsonObject[],
): string => {
  const p = withoutId(provenance);
  const extensions = ((p.extension as JsonObject[] | undefined) ?? []).filter(
    (extension) => extension.url !== GroveUrl.recordVersionExtension,
  );
  if (extensions.length > 0) p.extension = extensions;
  else delete p.extension;
  return recordContentDigestFromCanonical(
    canonicalBytes(p),
    outputs.map((output) => canonicalBytes(withoutId(output))),
  );
};

/** Same as {@link recordContentDigest} for pre-canonicalized parts. */
const recordContentDigestFromCanonical = (
  provenance: Buffer,
  outputs: Buffer[],
): string =>
  sha256Base64url(
    frameFields([
      Buffer.from(RECORD_CONTENT_DOMAIN, "utf8"),
      provenance,
      ...outputs,
    ]),
  );

/**
 * Deployment-scoped pseudonym of a provider account. Never the provider's own
 * user id: it keys the provider scope Identifier pair, which is a preimage
 * component and must not disclose the native account id.
 */
export const providerAccountPseudonym = (
  key: GroveIdentityKey,
  providerCode: string,
  providerUserId: string,
): string =>
  base64urlNoPadding(
    createHmac("sha256", key.key)
      .update(
        frameFields([
          "edu.stanford.myheartcounts.provider-account.v0",
          providerCode,
          providerUserId,
        ]),
      )
      .digest(),
  );
