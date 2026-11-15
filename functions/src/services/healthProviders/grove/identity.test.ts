// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHash } from "crypto";
import { expect } from "chai";
import { canonicalizeValue } from "./canonicalJson.js";
import { exchangeProtocolTestVectors as vectors } from "./exchangeProtocolVectors.js";
import {
  assertProductionKey,
  deriveIdentityValue,
  entryFullUrl,
  GroveIdentityError,
  type IdentityKind,
  identitySystem,
  recordContentDigest,
} from "./identity.js";

const testKey = {
  key: Buffer.from(vectors.keyHex, "hex"),
  keyId: vectors.keyId,
  epoch: vectors.epoch,
  root: "https://study.example.org/fhir",
};

describe("grove identity: exchange-protocol test vectors", () => {
  for (const vector of vectors.identities) {
    it(`derives ${vector.id}`, () => {
      expect(
        deriveIdentityValue(testKey, vector.identityKind as IdentityKind, [
          ...vector.components,
        ]),
      ).to.equal(vector.value);
    });
  }

  for (const vector of vectors.invalidIdentities) {
    it(`rejects ${vector.id} with ${vector.expectedError}`, () => {
      expect(() =>
        deriveIdentityValue(testKey, vector.identityKind as IdentityKind, [
          ...vector.components,
        ]),
      )
        .to.throw(GroveIdentityError)
        .with.property("code", vector.expectedError);
    });
  }

  it("builds the recommended identifier systems", () => {
    for (const entry of vectors.identitySystems) {
      expect(
        identitySystem(testKey, entry.identityKind as IdentityKind),
      ).to.equal(entry.system);
    }
  });

  for (const vector of vectors.fullUrls) {
    it(`computes fullUrl ${vector.id}`, () => {
      expect(entryFullUrl(vector.system, vector.value)).to.equal(
        vector.fullUrl,
      );
    });
  }
});

describe("grove canonical JSON and record version: test vectors", () => {
  for (const vector of vectors.canonicalJson) {
    it(`canonicalizes ${vector.id}`, () => {
      const canonical = canonicalizeValue(JSON.parse(vector.input));
      expect(canonical).to.equal(vector.canonical);
      expect(
        createHash("sha256").update(canonical, "utf8").digest("hex"),
      ).to.equal(vector.sha256);
    });
  }

  for (const vector of vectors.recordContents) {
    it(`computes the record-content digest of ${vector.id}`, () => {
      expect(
        recordContentDigest(
          JSON.parse(vector.provenance) as Record<string, unknown>,
          vector.outputs.map(
            (output) => JSON.parse(output) as Record<string, unknown>,
          ),
        ),
      ).to.equal(vector.recordContentDigest);
    });
  }
});

describe("grove identity: production key guard", () => {
  it("rejects the public conformance key", () => {
    expect(() => assertProductionKey({ ...testKey, keyId: "prod" })).to.throw(
      GroveIdentityError,
    );
  });

  it("rejects short keys and accepts a proper key", () => {
    const prod = { ...testKey, keyId: "prod" };
    expect(() =>
      assertProductionKey({ ...prod, key: Buffer.alloc(16, 7) }),
    ).to.throw(GroveIdentityError);
    expect(() =>
      assertProductionKey({ ...prod, key: Buffer.alloc(32, 7) }),
    ).to.not.throw();
  });
});
