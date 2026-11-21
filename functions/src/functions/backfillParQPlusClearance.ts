// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { privilegedServiceAccount } from "./helpers.js";
import { type DatabaseService } from "../services/database/databaseService.js";
import { FirestoreService } from "../services/database/firestoreService.js";
import { ParQPlusClearanceQuestionnaireResponseService } from "../services/questionnaireResponse/parQPlusClearanceService.js";

// One-off migration for users who answered the Par-Q+ before the flag
// existed. Idempotent: users that already carry the flag are skipped.
export const backfillParQPlusClearance = async (
  databaseService: DatabaseService,
): Promise<void> => {
  const service = new ParQPlusClearanceQuestionnaireResponseService({
    databaseService,
  });
  const users = await databaseService.getQuery((collections) =>
    collections.firestore.collection("users"),
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of users) {
    if ("parQPlusAuthored" in user.content) {
      skipped += 1;
      continue;
    }
    try {
      const responses = await databaseService.getQuery((collections) =>
        collections.userQuestionnaireResponses(user.id),
      );
      // Newest first, so the first Par-Q+ response handled is the one that counts.
      responses.sort(
        (a, b) => b.content.authored.getTime() - a.content.authored.getTime(),
      );
      for (const response of responses) {
        if (await service.handle(user.id, response, { isNew: false })) {
          updated += 1;
          break;
        }
      }
    } catch (error) {
      failed += 1;
      logger.error(
        `Failed to backfill Par-Q+ clearance for user ${user.id}: ${String(error)}`,
      );
    }
  }

  logger.info(
    `Par-Q+ clearance backfill complete: scanned=${users.length}, updated=${updated}, skipped=${skipped}, failed=${failed}`,
  );
};

export const backfillParQPlusClearanceScheduled = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "UTC",
    timeoutSeconds: 1800,
    serviceAccount: privilegedServiceAccount,
  },
  async () => {
    await backfillParQPlusClearance(new FirestoreService(admin.firestore()));
  },
);
