// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { https, logger } from "firebase-functions/v2";
import { z } from "zod";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";
import { validatedOnCall, defaultServiceAccount } from "./helpers.js";

const markAccountForDeletionInputSchema = z.object({});

interface MarkAccountForDeletionOutput {
  success: boolean;
  markedAt: string;
}

export const markAccountForDeletion = validatedOnCall(
  "markAccountForDeletion",
  markAccountForDeletionInputSchema,
  async (request): Promise<MarkAccountForDeletionOutput> => {
    const factory = getServiceFactory();
    const credential = factory.credential(request.auth);
    const userService = factory.user();

    const userId = request.auth?.uid;
    if (!userId) {
      throw new https.HttpsError(
        "unauthenticated",
        "User must be authenticated",
      );
    }

    credential.checkUser(userId);

    const user = await userService.getUser(userId);
    if (!user) {
      throw new https.HttpsError("not-found", "User account not found");
    }

    if (user.content.disabled) {
      throw new https.HttpsError(
        "failed-precondition",
        "Cannot mark disabled account for deletion",
      );
    }

    const markedAt = new Date();
    await userService.markAccountForDeletion(userId, markedAt);

    logger.info(
      `User ${userId} successfully marked their account for deletion`,
    );

    return {
      success: true,
      markedAt: markedAt.toISOString(),
    };
  },
  {
    invoker: "public",
    serviceAccount: defaultServiceAccount,
  },
);
