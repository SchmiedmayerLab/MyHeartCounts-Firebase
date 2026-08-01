// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { privilegedServiceAccount } from "./helpers.js";
import { CollectionsService } from "../services/database/collections.js";

/**
 * Debounce window for collapsing a burst of writes into a single snapshot.
 *
 * If a meaningful change arrives within this window of the most recent
 * snapshot, that snapshot is overwritten with the settled state instead of
 * appending a new one. A continuous editing session therefore keeps updating
 * one snapshot until a quiet gap longer than the window occurs.
 */
export const DEBOUNCE_WINDOW_MS = 120_000;

/**
 * Top-level keys excluded from user-document snapshots.
 *
 * A write that only changes excluded keys produces the same filtered content
 * as the previous snapshot, so no new snapshot is created. These are
 * volatile/bookkeeping fields that are not demographic and would otherwise
 * make every write look like a change.
 *
 * This is the single place to tune what gets tracked.
 */
const EXCLUDED_KEYS = new Set<string>([
  "fcmToken",
  "fcmNotificationsToken",
  "updated_at",
  "lastActiveDate",
  "lastUploadDate",
  "mostRecentOnboardingStep",
]);

interface UserDocumentSnapshot {
  content: Record<string, unknown>;
  capturedAt: Timestamp;
  sourceUpdatedAt: Timestamp | null;
}

/**
 * Removes excluded keys (top-level) and `undefined` values from a raw user
 * document so the snapshot only carries meaningful, comparable content.
 */
const filterSnapshotContent = (
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
 * Captures a point-in-time snapshot of the filtered post-write user document
 * into `users/{userId}/documentSnapshots`, debouncing bursts of writes.
 *
 * Exported (rather than inlined in the trigger) so it can be exercised directly
 * against the emulator, with `now` injected to drive the debounce window
 * deterministically.
 *
 * The decision runs inside a transaction so concurrent writes serialize: the
 * losing run retries, re-reads the latest snapshot, and converges to a single
 * settled doc.
 */
export const captureUserDocumentSnapshot = async (
  userId: string,
  afterData: Record<string, unknown>,
  sourceUpdatedAt: Timestamp | null,
  now: Timestamp = Timestamp.now(),
): Promise<void> => {
  const firestore = admin.firestore();
  const snapshotsRef = new CollectionsService(firestore).userDocumentSnapshots(
    userId,
  );

  const filtered = filterSnapshotContent(afterData);
  const payload: UserDocumentSnapshot = {
    content: filtered,
    capturedAt: now,
    sourceUpdatedAt,
  };

  await firestore.runTransaction(async (transaction) => {
    const latestQuery = await transaction.get(
      snapshotsRef.orderBy("capturedAt", "desc").limit(1),
    );
    const latest = latestQuery.docs.at(0);

    // Nothing meaningful changed
    if (
      latest !== undefined &&
      isDeepStrictEqual(latest.get("content"), filtered)
    ) {
      return;
    }

    const withinWindow =
      latest !== undefined &&
      now.toMillis() - (latest.get("capturedAt") as Timestamp).toMillis() <=
        DEBOUNCE_WINDOW_MS;
    // Within the window: collapse the burst by overwriting the most recent
    // snapshot in place; otherwise append a new snapshot.
    transaction.set(
      withinWindow ? latest.ref : snapshotsRef.doc(randomUUID()),
      payload,
    );
  });
};

export const onUserDocumentSnapshot = onDocumentWritten(
  {
    document: "users/{userId}",
    serviceAccount: privilegedServiceAccount,
  },
  async (event) => {
    const after = event.data?.after;
    // Document deleted, no-op. The user doc and its subcollections are removed
    // recursively by processUserDeletions, so a tombstone would be orphaned.
    if (after?.exists !== true) return;

    await captureUserDocumentSnapshot(
      event.params.userId,
      after.data() as Record<string, unknown>,
      after.updateTime ?? null,
    );
  },
);
