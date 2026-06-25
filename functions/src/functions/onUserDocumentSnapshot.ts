// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { privilegedServiceAccount } from "./helpers.js";
import {
  contentHash,
  filterSnapshotContent,
} from "../services/userSnapshot/userSnapshotContent.js";

/**
 * Subcollection under each user that holds the snapshot history.
 * Writes are server-only (see firestore.rules); clients may read their own.
 */
export const USER_DOCUMENT_SNAPSHOTS_COLLECTION = "documentSnapshots";

/**
 * Debounce window for collapsing a burst of writes into a single snapshot.
 *
 * If a meaningful change arrives within this window of the most recent
 * snapshot, that snapshot is overwritten with the settled state instead of
 * appending a new one. A continuous editing session therefore keeps updating
 * one snapshot until a quiet gap longer than the window occurs.
 */
export const DEBOUNCE_WINDOW_MS = 120_000;

interface UserDocumentSnapshot {
  content: Record<string, unknown>;
  contentHash: string;
  capturedAt: Timestamp;
  sourceUpdatedAt: Timestamp | null;
}

/**
 * Captures a point-in-time snapshot of the (already filtered) post-write user
 * document into `users/{userId}/documentSnapshots`, debouncing bursts of
 * writes.
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
  sourceUpdatedAt: Timestamp | null = null,
  now: Timestamp = Timestamp.now(),
): Promise<void> => {
  const firestore = admin.firestore();
  const snapshotsRef = firestore
    .collection("users")
    .doc(userId)
    .collection(USER_DOCUMENT_SNAPSHOTS_COLLECTION);

  const filtered = filterSnapshotContent(afterData);
  const hash = contentHash(filtered);

  await firestore.runTransaction(async (transaction) => {
    const latestQuery = await transaction.get(
      snapshotsRef.orderBy("capturedAt", "desc").limit(1),
    );
    const latest = latestQuery.docs.at(0);

    // Nothing meaningful changed
    if (latest?.get("contentHash") === hash) {
      return;
    }

    const payload: UserDocumentSnapshot = {
      content: filtered,
      contentHash: hash,
      capturedAt: now,
      sourceUpdatedAt,
    };

    if (latest !== undefined) {
      const latestCapturedAt = latest.get("capturedAt") as
        | Timestamp
        | undefined;
      const withinWindow =
        latestCapturedAt !== undefined &&
        now.toMillis() - latestCapturedAt.toMillis() <= DEBOUNCE_WINDOW_MS;
      if (withinWindow) {
        // Collapse the burst; overwrite the most recent snapshot in place
        transaction.set(latest.ref, payload);
        return;
      }
    }

    transaction.set(snapshotsRef.doc(), payload);
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
