// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { https, logger } from "firebase-functions/v2";
import { z } from "zod";
import { validatedOnCall, privilegedServiceAccount } from "./helpers.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";
import { HealthSampleDeletionService } from "../services/healthSamples/healthSampleDeletionService.js";

const markHealthSamplesEnteredInErrorInputSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  collection: z.string().min(1, "Collection name is required"),
  documentIds: z
    .array(z.string().min(1, "Document ID is required"))
    .min(1, "At least one document ID is required")
    .max(50000, "Too many document IDs (max 50,000)"),
});

interface MarkHealthSamplesEnteredInErrorOutput {
  status: "accepted";
  jobId: string;
  totalSamples: number;
  totalMarked: number;
  totalQueued: number;
  totalSkipped: number;
  totalFailed: number;
  message: string;
}

export const deleteHealthSamples = validatedOnCall(
  "deleteHealthSamples",
  markHealthSamplesEnteredInErrorInputSchema,
  async (request): Promise<MarkHealthSamplesEnteredInErrorOutput> => {
    const factory = getServiceFactory();
    const credential = factory.credential(request.auth);
    const { userId, collection, documentIds } = request.data;

    credential.checkUser(userId);

    // Check if user has withdrawn from study
    const userData = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .get();
    const userDataContent = userData.data() as
      | { hasWithdrawnFromStudy?: boolean }
      | undefined;
    const hasWithdrawnFromStudy =
      userDataContent?.hasWithdrawnFromStudy ?? false;

    if (hasWithdrawnFromStudy) {
      logger.error(
        `User ${userId} attempted to delete health samples but has withdrawn from study`,
      );
      throw new https.HttpsError(
        "failed-precondition",
        "Cannot delete health samples - user has withdrawn from study",
      );
    }

    const jobId = `del_${Date.now()}_${Math.random().toString(36).substring(2)}`;

    const deletionService = new HealthSampleDeletionService();

    let summary;
    try {
      summary = await deletionService.processHealthSamplesEnteredInError(
        jobId,
        credential.userId,
        userId,
        collection,
        documentIds,
      );
    } catch (error: unknown) {
      logger.error(
        `Entered-in-error marking job '${jobId}' failed with error: ${String(error)}`,
        {
          jobId,
          requestingUserId: credential.userId,
          targetUserId: userId,
          collection,
          error: String(error),
        },
      );
      throw new https.HttpsError(
        "internal",
        `Entered-in-error marking job '${jobId}' failed`,
      );
    }

    return {
      status: "accepted",
      jobId,
      totalSamples: documentIds.length,
      totalMarked: summary.totalMarked,
      totalQueued: summary.totalQueued,
      totalSkipped: summary.totalSkipped,
      totalFailed: summary.totalFailed,
      message: `Marking job completed. ${summary.totalMarked} marked, ${summary.totalQueued} queued for retry, ${summary.totalSkipped} skipped, ${summary.totalFailed} failed out of ${documentIds.length} samples.`,
    };
  },
  {
    invoker: "public",
    serviceAccount: privilegedServiceAccount,
    memory: "1GiB",
    timeoutSeconds: 3600,
  },
);
