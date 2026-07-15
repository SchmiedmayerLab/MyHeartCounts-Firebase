// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { https } from "firebase-functions/v2";
import { z } from "zod";
import { validatedOnCall, defaultServiceAccount } from "./helpers.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

const markAccountForStudyWithdrawalInputSchema = z.object({});

interface MarkAccountForStudyWithdrawalOutput {
  success: boolean;
  withdrawnAt: string;
}

export const markAccountForStudyWithdrawal = validatedOnCall(
  "markAccountForStudyWithdrawal",
  markAccountForStudyWithdrawalInputSchema,
  async (request): Promise<MarkAccountForStudyWithdrawalOutput> => {
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
        "Cannot mark disabled account for study withdrawal",
      );
    }

    const withdrawnAt = new Date();
    await userService.markAccountForStudyWithdrawal(userId, withdrawnAt);

    return {
      success: true,
      withdrawnAt: withdrawnAt.toISOString(),
    };
  },
  {
    invoker: "public",
    serviceAccount: defaultServiceAccount,
  },
);
