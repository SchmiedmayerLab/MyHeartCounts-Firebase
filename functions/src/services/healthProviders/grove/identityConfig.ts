// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { MHC_FHIR_ROOT } from "./constants.js";
import { assertProductionKey, type GroveIdentityKey } from "./identity.js";
import {
  getHealthProviderIdentityEpoch,
  getHealthProviderIdentityKey,
  getHealthProviderIdentityKeyId,
} from "../../../env.js";

/** Decode a hex (64+ hex chars) or base64/base64url encoded key. */
export const decodeIdentityKey = (encoded: string): Buffer => {
  const trimmed = encoded.trim();
  if (/^(?:[0-9a-fA-F]{2}){32,}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  return Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
};

/**
 * The deployment's Grove identity key, validated: at least 32 bytes and never
 * the public conformance test key.
 */
export const loadGroveIdentityKey = (): GroveIdentityKey => {
  const key: GroveIdentityKey = {
    key: decodeIdentityKey(getHealthProviderIdentityKey()),
    keyId: getHealthProviderIdentityKeyId(),
    epoch: getHealthProviderIdentityEpoch(),
    root: MHC_FHIR_ROOT,
  };
  assertProductionKey(key);
  return key;
};
