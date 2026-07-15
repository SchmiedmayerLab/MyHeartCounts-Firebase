// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { https, logger } from "firebase-functions";
import {
  beforeUserCreated,
  beforeUserSignedIn,
} from "firebase-functions/v2/identity";
import { defaultServiceAccount } from "./helpers.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

export const beforeUserCreatedFunction = beforeUserCreated(
  {
    serviceAccount: defaultServiceAccount,
  },
  async (event) => {
    // Ensure event.data exists
    if (!event.data) {
      logger.error("User data not available in event");
      throw new https.HttpsError("invalid-argument", "User data is required.");
    }

    const userId = event.data.uid;

    const factory = getServiceFactory();
    const userService = factory.user();

    // Check for email
    if (event.data.email === undefined) {
      logger.error("Email address not set.");
      throw new https.HttpsError(
        "invalid-argument",
        "Email address is required for user.",
      );
    }

    try {
      // For MyHeartCounts, we'll use direct enrollment without invitations
      const userDoc = await userService.enrollUserDirectly(userId, {
        isSingleSignOn: event.credential !== undefined,
      });

      // Trigger any post-enrollment actions
      await factory.trigger().userEnrolled(userDoc);

      // Return empty claims - they'll be updated by userEnrolled trigger
      return { customClaims: {} };
    } catch (error) {
      logger.error(
        `${userId}: Failed to create user document: ${String(error)}`,
      );
      // We don't throw here because we still want to allow sign-up even if
      // document creation fails (it can be created later)
      return { customClaims: {} };
    }
  },
);

export const beforeUserSignedInFunction = beforeUserSignedIn(
  {
    serviceAccount: defaultServiceAccount,
  },
  async (event) => {
    // Ensure event.data exists
    if (!event.data) {
      logger.error("User data not available in event");
      throw new https.HttpsError("invalid-argument", "User data is required.");
    }

    try {
      const userService = getServiceFactory().user();
      const user = await userService.getUser(event.data.uid);
      if (user !== undefined) {
        return {
          customClaims: user.content.claims,
          sessionClaims: user.content.claims,
        };
      }
      return { customClaims: {} };
    } catch (error) {
      logger.error(`beforeUserSignedIn finished with error: ${String(error)}`);
      throw new https.HttpsError(
        "internal",
        "Unable to verify user claims. Please try again.",
      );
    }
  },
);
