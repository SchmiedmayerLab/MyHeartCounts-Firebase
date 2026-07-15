// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { storage, logger } from "firebase-functions/v2";
import { decompress } from "fzstd";
import { privilegedServiceAccount } from "./helpers.js";

interface ObservationWithId {
  id: string;
  [key: string]: unknown;
}

const getCollectionNameFromFileName = (fileName: string): string | null => {
  // Check for SensorKit data files
  // Pattern: com.apple.SensorKit.{dataType}_{UUID}.json.zstd
  const sensorKitPattern =
    /com\.apple\.SensorKit\.([^_]+)_[A-Fa-f0-9-]+\.json\.zstd$/;
  const sensorKitMatch = sensorKitPattern.exec(fileName);

  if (sensorKitMatch) {
    const sensorKitDataType = sensorKitMatch[1];
    return `SensorKitObservations_${sensorKitDataType}`;
  }

  // Check for HealthKit data files
  // Pattern: must include "Identifier"
  const hkIdentifierPattern = /[A-Za-z]*Identifier[A-Za-z]*/;
  const hkMatch = hkIdentifierPattern.exec(fileName);

  if (hkMatch) {
    const healthKitIdentifier = hkMatch[0];
    return `HealthObservations_${healthKitIdentifier}`;
  }

  logger.error(
    `Could not extract HealthKit or SensorKit identifier from filename: ${fileName}`,
  );
  return null;
};

export const processArchivedLiveHealthSampleObject = async (
  bucketName: string,
  filePath: string,
): Promise<void> => {
  if (!filePath.includes("/liveHealthSamples/")) {
    return;
  }

  const pathParts = filePath.split("/");
  const userIdIndex = pathParts.findIndex((part) => part === "users");

  if (userIdIndex === -1 || userIdIndex + 1 >= pathParts.length) {
    logger.error(`Invalid file path structure: ${filePath}`);
    return;
  }

  const userId = pathParts[userIdIndex + 1];
  const fileName = pathParts[pathParts.length - 1];

  if (!userId || !fileName) {
    logger.error(`Could not extract userId or fileName from path: ${filePath}`);
    return;
  }

  try {
    const bucket = admin.storage().bucket(bucketName);
    const file = bucket.file(filePath);

    const [exists] = await file.exists();
    if (!exists) {
      logger.error(`File ${filePath} does not exist`);
      return;
    }

    const [fileBuffer] = await file.download();

    // Decompress so decompressedData is eligible for GC
    // before JSON.parse allocates the full object graph here
    let jsonString: string;
    try {
      const decompressedData = Buffer.from(decompress(fileBuffer));
      jsonString = decompressedData.toString("utf8");
    } catch (error) {
      logger.error(`Failed to decompress file ${fileName}:`, error);
      return;
    }

    let observationsData: unknown[];
    try {
      const parsedData: unknown = JSON.parse(jsonString);
      if (!Array.isArray(parsedData)) {
        logger.error(
          `Invalid data format in file ${fileName} - expected JSON array`,
        );
        return;
      }
      observationsData = parsedData;
    } catch (error) {
      logger.error(
        `Failed to parse JSON from decompressed data for file ${fileName}:`,
        error,
      );
      return;
    }

    if (!Array.isArray(observationsData) || observationsData.length === 0) {
      // Still delete the file even if empty
      try {
        await file.delete();
      } catch (error) {
        logger.error(`Failed to delete empty file ${filePath}:`, error);
      }
      return;
    }

    // Determine collection name from filename
    const collectionName = getCollectionNameFromFileName(fileName);

    if (!collectionName) {
      logger.error(
        `Cannot determine collection name from filename: ${fileName}`,
      );
      return;
    }

    const userObservationsCollection = admin
      .firestore()
      .collection("users")
      .doc(userId)
      .collection(collectionName);

    // Firestore limits: 500 operations per batch, 10MB gRPC request payload.
    // Large SensorKit observations (e.g. deviceUsageReport) can cause the
    // payload limit here to be hit before the operation limit, so we need track both.
    const BATCH_SIZE = 500;
    const MAX_BATCH_BYTES = 9 * 1024 * 1024; // 9MB
    let processedCount = 0;
    let currentBatch = admin.firestore().batch();
    let batchOperations = 0;
    let batchBytes = 0;

    for (const observation of observationsData) {
      try {
        // Extract the observation ID for use as document ID
        if (
          !observation ||
          typeof observation !== "object" ||
          !("id" in observation)
        ) {
          continue;
        }

        const observationData = observation as ObservationWithId;
        const documentId = observationData.id;

        if (typeof documentId !== "string") {
          continue;
        }

        const serializedSize = JSON.stringify(observation).length;

        // Commit before adding if it would exceed one of the limits
        if (
          batchOperations > 0 &&
          (batchOperations >= BATCH_SIZE ||
            batchBytes + serializedSize > MAX_BATCH_BYTES)
        ) {
          await currentBatch.commit();
          currentBatch = admin.firestore().batch();
          batchOperations = 0;
          batchBytes = 0;
        }

        const docRef = userObservationsCollection.doc(documentId);
        currentBatch.set(docRef, observation);
        batchOperations++;
        batchBytes += serializedSize;
        processedCount++;
      } catch (error) {
        logger.error(`Failed to prepare observation for batch write:`, error);
      }
    }

    // Commit any remaining operations in the final batch
    if (batchOperations > 0) {
      await currentBatch.commit();
    }

    if (processedCount === 0) {
      logger.warn(
        `No valid observations found in file ${fileName} for user ${userId}`,
      );
    }

    try {
      await file.delete();
    } catch (error) {
      logger.error(`Failed to delete processed file ${filePath}:`, error);
    }
  } catch (error) {
    logger.error(`Unexpected error processing file ${filePath}:`, error);
  }
};

export const onArchivedLiveHealthSampleUploaded = storage.onObjectFinalized(
  {
    cpu: 2,
    memory: "2GiB",
    timeoutSeconds: 300,
    serviceAccount: privilegedServiceAccount,
  },
  async (event) => {
    await processArchivedLiveHealthSampleObject(
      event.data.bucket,
      event.data.name,
    );
  },
);
