// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { privilegedServiceAccount } from "./helpers.js";

const BATCH_SIZE = 400;

export const backfillExtendedActivityNudgesOptIn = async (): Promise<void> => {
  const firestore = admin.firestore();
  const usersSnapshot = await firestore.collection("users").get();

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  let batch = firestore.batch();
  let pendingWrites = 0;

  const commitBatch = async () => {
    if (pendingWrites === 0) return;
    await batch.commit();
    batch = firestore.batch();
    pendingWrites = 0;
  };

  for (const doc of usersSnapshot.docs) {
    scanned += 1;
    try {
      const data = doc.data();
      if (data.extendedActivityNudgesOptIn !== undefined) {
        skipped += 1;
        continue;
      }

      batch.update(doc.ref, { extendedActivityNudgesOptIn: true });
      pendingWrites += 1;
      updated += 1;

      if (pendingWrites >= BATCH_SIZE) {
        await commitBatch();
      }
    } catch (error) {
      failed += 1;
      logger.error(
        `Failed to backfill extendedActivityNudgesOptIn for user ${doc.id}:`,
        error,
      );
    }
  }

  try {
    await commitBatch();
  } catch (error) {
    logger.error(
      "Failed to commit final batch of extendedActivityNudgesOptIn backfill:",
      error,
    );
  }

  logger.info(
    `extendedActivityNudgesOptIn backfill complete: scanned=${scanned}, updated=${updated}, skipped=${skipped}, failed=${failed}`,
  );
};

export const backfillExtendedActivityNudgesOptInScheduled = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "UTC",
    timeoutSeconds: 1800,
    serviceAccount: privilegedServiceAccount,
  },
  async (_event) => {
    await backfillExtendedActivityNudgesOptIn();
  },
);
