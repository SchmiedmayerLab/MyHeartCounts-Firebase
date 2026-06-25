// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";

/**
 * Top-level keys excluded from user-document snapshots.
 *
 * A write that only changes excluded keys produces the same filtered content
 * (and thus the same hash) as the previous snapshot, so no new snapshot is
 * created. These are volatile/bookkeeping fields that are not demographic and
 * would otherwise make every write look like a change.
 *
 * This is the single place to tune what gets tracked.
 */
export const EXCLUDED_KEYS = new Set<string>([
  "fcmToken",
  "fcmNotificationsToken",
  "updated_at",
  "lastActiveDate",
  "lastUploadDate",
  "mostRecentOnboardingStep",
]);

/**
 * Removes excluded keys (top-level) and `undefined` values from a raw user
 * document so the snapshot only carries meaningful, comparable content.
 */
export const filterSnapshotContent = (
  raw: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    result[key] = value;
  }
  return result;
};

/**
 * Produces a deterministic, comparison-safe representation of arbitrary
 * Firestore content:
 * - Firestore `Timestamp` and `Date` become `{ __ts: millis }` (no float drift)
 * - arrays keep their order
 * - object keys are sorted recursively
 *
 * The repo has no deep-equal utility, so this canonical form is hashed to
 * detect changes.
 */
const canonicalize = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (value instanceof Timestamp) return { __ts: value.toMillis() };
  if (value instanceof Date) return { __ts: value.getTime() };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      result[key] = canonicalize(object[key]);
    }
    return result;
  }
  return value;
};

export const canonicalString = (content: Record<string, unknown>): string =>
  JSON.stringify(canonicalize(content));

export const contentHash = (content: Record<string, unknown>): string =>
  createHash("sha256").update(canonicalString(content)).digest("hex");
