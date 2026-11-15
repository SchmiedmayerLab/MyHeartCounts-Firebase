// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * `grove-canonical-json-v0` (grove-fhir `catalog/exchange-protocol.json`
 * `canonicalJson`) for JS values this backend builds itself: no whitespace,
 * members sorted by code unit order of their ASCII names, `undefined` members
 * dropped. String escaping is RFC 8785 §3.2.2.2, which is exactly what
 * `JSON.stringify` produces; a JS number has a single lexeme, so number
 * preservation is lossless by construction.
 */
export const canonicalizeValue = (value: unknown): string => {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("grove-canonical-json-v0: non-finite number");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item ?? null)).join(",")}]`;
  }
  const members = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([lhs], [rhs]) =>
      lhs < rhs ? -1
      : lhs > rhs ? 1
      : 0,
    )
    .map(
      ([name, member]) =>
        `${JSON.stringify(name)}:${canonicalizeValue(member)}`,
    );
  return `{${members.join(",")}}`;
};

/** UTF-8 bytes of {@link canonicalizeValue}. */
export const canonicalBytes = (value: unknown): Buffer =>
  Buffer.from(canonicalizeValue(value), "utf8");
