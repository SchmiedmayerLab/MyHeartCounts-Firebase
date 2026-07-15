// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { logger } from "firebase-functions/v2";
import { HealthSampleDeletionQueueService } from "./healthSampleDeletionQueueService.js";
import { FHIRObservationStatus } from "../../models/index.js";
import { CollectionsService } from "../database/collections.js";

export interface HealthSampleDeletionResult {
  totalMarked: number;
  totalSkipped: number;
  totalFailed: number;
  totalQueued: number;
  successRate: string;
}

export class HealthSampleDeletionService {
  private readonly collections: CollectionsService;
  private readonly queueService: HealthSampleDeletionQueueService;

  // Max simultaneous Firestore RPCs. Keeping this low prevents DEADLINE_EXCEEDED
  // errors that occur when hundreds of concurrent ops saturate the connection pool.
  private readonly CONCURRENCY_LIMIT = 25;

  // gRPC / Firebase error codes that are safe to retry automatically.
  // Numeric codes come from raw gRPC transport; string codes from FirestoreError.
  // 4 / "deadline-exceeded"  – DEADLINE_EXCEEDED
  // 8 / "resource-exhausted" – RESOURCE_EXHAUSTED
  // 14 / "unavailable"       – UNAVAILABLE
  private readonly TRANSIENT_NUMERIC_CODES = new Set([4, 8, 14]);
  private readonly TRANSIENT_STRING_CODES = new Set([
    "deadline-exceeded",
    "resource-exhausted",
    "unavailable",
  ]);

  // gRPC / Firebase NOT_FOUND – document does not exist.
  private readonly NOT_FOUND_NUMERIC = 5;
  private readonly NOT_FOUND_STRING = "not-found";

  private readonly MAX_RETRIES = 1;
  private readonly RETRY_BASE_DELAY_MS = 250;

  constructor(
    firestore?: admin.firestore.Firestore,
    queueService?: HealthSampleDeletionQueueService,
  ) {
    const fs = firestore ?? admin.firestore();
    this.collections = new CollectionsService(fs);
    this.queueService =
      queueService ?? new HealthSampleDeletionQueueService(fs);
  }

  async processHealthSamplesEnteredInError(
    jobId: string,
    requestingUserId: string,
    targetUserId: string,
    collection: string,
    documentIds: string[],
  ): Promise<HealthSampleDeletionResult> {
    let totalMarked = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let totalQueued = 0;

    const results = await this.runWithConcurrencyLimit(
      documentIds,
      this.CONCURRENCY_LIMIT,
      async (documentId) =>
        this.markSampleAsEnteredInError(
          targetUserId,
          collection,
          documentId,
          jobId,
          requestingUserId,
        ),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.success) {
        totalMarked++;
      } else if (
        result.status === "fulfilled" &&
        result.value.reason === "QUEUED"
      ) {
        totalQueued++;
      } else if (
        result.status === "fulfilled" &&
        result.value.reason === "NOT_FOUND"
      ) {
        totalSkipped++;
      } else {
        totalFailed++;
        if (result.status === "rejected") {
          logger.error(
            `Unhandled promise rejection in job '${jobId}': ${String(result.reason)}`,
            { jobId, error: String(result.reason) },
          );
        }
      }
    }

    const successRate =
      ((totalMarked / documentIds.length) * 100).toFixed(2) + "%";

    return { totalMarked, totalSkipped, totalFailed, totalQueued, successRate };
  }

  /**
   * Marks a single sample as entered-in-error via a direct update (no prior
   * read), retrying on transient errors. Treats NOT_FOUND as a soft skip
   * rather than a failure worth retrying.
   */
  private async markSampleAsEnteredInError(
    userId: string,
    collection: string,
    documentId: string,
    jobId: string,
    requestingUserId: string,
  ): Promise<{ success: boolean; reason?: "NOT_FOUND" | "QUEUED" }> {
    const ref = this.collections.firestore
      .collection("users")
      .doc(userId)
      .collection(collection)
      .doc(documentId);

    try {
      await this.withRetry(() =>
        ref.update({ status: FHIRObservationStatus.entered_in_error }),
      );
      return { success: true };
    } catch (error) {
      await this.queueService.enqueue({
        userId,
        collection,
        documentId,
        jobId,
        requestingUserId,
        reason: this.isNotFoundError(error) ? "NOT_FOUND" : "TRANSIENT_ERROR",
        lastError: String(error),
      });
      return { success: false, reason: "QUEUED" };
    }
  }

  /**
   * Worker-pool concurrency limiter. Spawns `limit` workers that each pull
   * the next item from a shared index, so a slow item never blocks others.
   * Returns a PromiseSettledResult array in the same order as `items`.
   */
  private async runWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<Array<PromiseSettledResult<R>>> {
    const results = new Array<PromiseSettledResult<R>>(items.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await fn(items[index]),
          };
        } catch (error) {
          results[index] = { status: "rejected", reason: error };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, worker),
    );

    return results;
  }

  /**
   * Retries `operation` up to MAX_RETRIES times when a transient error occurs,
   * using exponential back-off with random jitter to spread retry storms.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this.isTransientError(error) || attempt >= this.MAX_RETRIES)
          throw error;

        const delay =
          this.RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  private isTransientError(error: unknown): boolean {
    const { numeric, string } = this.extractErrorCode(error);
    return (
      (numeric !== undefined && this.TRANSIENT_NUMERIC_CODES.has(numeric)) ||
      (string !== undefined && this.TRANSIENT_STRING_CODES.has(string))
    );
  }

  private isNotFoundError(error: unknown): boolean {
    const { numeric, string } = this.extractErrorCode(error);
    return (
      numeric === this.NOT_FOUND_NUMERIC || string === this.NOT_FOUND_STRING
    );
  }

  private extractErrorCode(error: unknown): {
    numeric?: number;
    string?: string;
  } {
    if (error === null || typeof error !== "object") return {};
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return { numeric: code };
    if (typeof code === "string") return { string: code };
    return {};
  }
}
