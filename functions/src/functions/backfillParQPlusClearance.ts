// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { privilegedServiceAccount } from "./helpers.js";
import {
  type FHIRQuestionnaireResponse,
  fhirQuestionnaireResponseConverter,
} from "../models/index.js";
import {
  type DatabaseService,
  type Document,
} from "../services/database/databaseService.js";
import { FirestoreService } from "../services/database/firestoreService.js";
import {
  ParQPlusClearanceQuestionnaireResponseService,
  parQPlusQuestionnaireUrl,
} from "../services/questionnaireResponse/parQPlusClearanceService.js";

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

  let handled = 0;
  let skipped = 0;
  let invalid = 0;
  let failed = 0;

  for (const user of users) {
    if ("parQPlusAuthored" in user.content) {
      skipped += 1;
      continue;
    }
    try {
      // Decode per document so one malformed legacy response cannot block the user.
      const raw = await databaseService.getQuery((collections) =>
        collections.firestore
          .collection("users")
          .doc(user.id)
          .collection("questionnaireResponses"),
      );
      const responses: Array<Document<FHIRQuestionnaireResponse>> = [];
      for (const doc of raw) {
        const data = doc.content as Record<string, unknown>;
        const url =
          typeof data.questionnaire === "string" ?
            data.questionnaire.split("|")[0]
          : undefined;
        if (url !== parQPlusQuestionnaireUrl) continue;
        const parsed =
          fhirQuestionnaireResponseConverter.value.schema.safeParse(data);
        if (!parsed.success) {
          invalid += 1;
          logger.warn(
            `Skipping malformed Par-Q+ response ${doc.path}: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
          );
          continue;
        }
        responses.push({ ...doc, content: parsed.data });
      }
      // Newest first, so the first response handled is the one that counts.
      responses.sort(
        (a, b) => b.content.authored.getTime() - a.content.authored.getTime(),
      );
      for (const response of responses) {
        if (await service.handle(user.id, response, { isNew: false })) {
          handled += 1;
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
    `Par-Q+ clearance backfill complete: scanned=${users.length}, handled=${handled}, skipped=${skipped}, invalid=${invalid}, failed=${failed}`,
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
