// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { Storage } from "@google-cloud/storage";
import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { privilegedServiceAccount } from "./helpers.js";
import type { User } from "../models/index.js";
import type { Document } from "../services/database/databaseService.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

const storage = new Storage();

export const deleteUserStorageFiles = async (userId: string): Promise<void> => {
  const projectId = process.env.GCLOUD_PROJECT;
  if (!projectId) {
    logger.error("GCLOUD_PROJECT environment variable not set");
    return;
  }

  const bucketNames = [
    `${projectId}.appspot.com`,
    process.env.DATA_COLLECTION_BUCKET,
  ].filter((name): name is string => !!name);
  const prefix = `users/${userId}/`;

  try {
    await Promise.all(
      bucketNames.map(async (bucketName) => {
        const [files] = await storage.bucket(bucketName).getFiles({ prefix });
        await Promise.all(files.map((file) => file.delete()));
      }),
    );
  } catch (error) {
    logger.error(`Failed to delete storage files for user ${userId}:`, error);
    throw error;
  }
};

// Type representing the raw user data with additional Firestore fields
interface UserDataWithDeletion extends Record<string, unknown> {
  toBeDeleted?: boolean;
}

export const processUserDeletions = async (): Promise<void> => {
  const factory = getServiceFactory();
  const userService = factory.user();

  try {
    const users = await userService.getAllPatients();
    const usersToDelete = users.filter((user: Document<User>) => {
      const userData = user.content as unknown as UserDataWithDeletion;
      return userData.toBeDeleted === true;
    });

    if (usersToDelete.length === 0) {
      return;
    }

    logger.info(`Found ${usersToDelete.length} users marked for deletion`);

    for (const user of usersToDelete) {
      const userId = user.id;

      try {
        await deleteUserStorageFiles(userId);
        await userService.deleteUser(userId);
      } catch (error) {
        logger.error(`Failed to delete user ${userId}:`, error);
      }
    }
  } catch (error) {
    logger.error("Error processing user deletions:", error);
  }
};

export const processUserDeletionsScheduled = onSchedule(
  {
    schedule: "every 30 minutes",
    timeZone: "UTC",
    timeoutSeconds: 1800,
    serviceAccount: privilegedServiceAccount,
  },
  async (_event) => {
    await processUserDeletions();
  },
);
