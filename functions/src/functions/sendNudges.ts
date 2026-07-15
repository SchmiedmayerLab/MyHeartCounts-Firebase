// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { privilegedServiceAccount } from "./helpers.js";

interface NotificationBacklogItem {
  title: string;
  body: string;
  timestamp: admin.firestore.Timestamp;
  [key: string]: unknown;
}

type NotificationArchiveItem = Omit<NotificationBacklogItem, "timestamp"> & {
  originalTimestamp: admin.firestore.Timestamp;
  processedTimestamp: admin.firestore.FieldValue;
  status: "sent" | "failed";
  errorMessage?: string;
};

export class NotificationService {
  // Properties

  private _firestore?: admin.firestore.Firestore;
  private _messaging?: admin.messaging.Messaging;

  // Constructor

  private get firestore(): admin.firestore.Firestore {
    this._firestore ??= admin.firestore();
    return this._firestore;
  }

  private get messaging(): admin.messaging.Messaging {
    this._messaging ??= admin.messaging();
    return this._messaging;
  }

  // Methods

  private buildArchiveItem(
    backlogItem: NotificationBacklogItem,
    status: "sent" | "failed",
    errorMessage?: string,
  ): NotificationArchiveItem {
    const { timestamp, ...passthrough } = backlogItem;
    return {
      ...passthrough,
      originalTimestamp: timestamp,
      processedTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      status,
      isLLMGenerated:
        typeof passthrough.isLLMGenerated === "boolean" ?
          passthrough.isLLMGenerated
        : false,
      ...(errorMessage && { errorMessage }),
    };
  }

  async sendNotificationToUser(
    userId: string,
    documentId: string,
    fcmToken: string,
    backlogItem: NotificationBacklogItem,
  ): Promise<void> {
    let status: "sent" | "failed" = "failed";
    let errorMessage: string | undefined = undefined;

    try {
      const notificationMessage = {
        token: fcmToken,
        notification: { title: backlogItem.title, body: backlogItem.body },
        data: {
          notificationId: documentId,
        },
      };

      const sendResult = await this.messaging.send(notificationMessage);

      if (sendResult) {
        status = "sent";
      } else {
        errorMessage = "Firebase messaging send returned falsy result";
      }
    } catch (error) {
      errorMessage = String(error);
      logger.error(
        `Error sending notification to user ${userId}: ${errorMessage}`,
      );
    }

    const archiveData = this.buildArchiveItem(
      backlogItem,
      status,
      errorMessage,
    );

    await this.firestore
      .collection("users")
      .doc(userId)
      .collection("notificationHistory")
      .doc(documentId)
      .set(archiveData);
  }

  async processNotificationBacklog(): Promise<void> {
    const now = new Date();

    const usersSnapshot = await this.firestore.collection("users").get();

    let totalProcessed = 0;
    let totalSent = 0;

    for (const userDoc of usersSnapshot.docs) {
      try {
        const userData = userDoc.data();
        const userId = userDoc.id;

        if (!userData.timeZone) {
          continue;
        }

        // Skip disabled users
        if (userData.disabled === true) {
          continue;
        }

        // Skip users who have withdrawn from the study
        if (userData.hasWithdrawnFromStudy === true) {
          continue;
        }

        const backlogSnapshot = await this.firestore
          .collection("users")
          .doc(userId)
          .collection("notificationBacklog")
          .get();

        for (const backlogDoc of backlogSnapshot.docs) {
          try {
            const backlogItem = backlogDoc.data() as NotificationBacklogItem;
            totalProcessed++;

            const notificationTime = backlogItem.timestamp.toDate();

            if (notificationTime <= now) {
              if (!userData.fcmToken) {
                const archiveData = this.buildArchiveItem(
                  backlogItem,
                  "failed",
                  "No FCM token available for user",
                );

                await this.firestore
                  .collection("users")
                  .doc(userId)
                  .collection("notificationHistory")
                  .doc(backlogDoc.id)
                  .set(archiveData);
              } else {
                await this.sendNotificationToUser(
                  userId,
                  backlogDoc.id,
                  userData.fcmToken as string,
                  backlogItem,
                );
              }

              totalSent++;
              await backlogDoc.ref.delete();
            }
          } catch (error) {
            logger.error(
              `Error processing backlog item for user ${userId}: ${String(error)}`,
            );
          }
        }
      } catch (error) {
        logger.error(`Error processing user ${userDoc.id}: ${String(error)}`);
      }
    }

    logger.info(
      `Backlog processing complete: ${totalSent} sent, ${totalProcessed} processed`,
    );
  }
}

let notificationService: NotificationService | undefined;

const getNotificationService = (): NotificationService => {
  notificationService ??= new NotificationService();
  return notificationService;
};

export const processNotificationBacklog = () =>
  getNotificationService().processNotificationBacklog();

export const onScheduleNotificationProcessor = onSchedule(
  {
    schedule: "*/15 * * * *",
    timeZone: "UTC",
    serviceAccount: privilegedServiceAccount,
  },
  async () => {
    logger.info("Starting notification backlog processing");

    try {
      await getNotificationService().processNotificationBacklog();
      logger.info("Notification backlog processing complete");
    } catch (error) {
      logger.error(
        `Error in notification backlog processing: ${String(error)}`,
      );
    }
  },
);
