// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { DocumentReference, Timestamp } from "firebase-admin/firestore";
import { restore, stub } from "sinon";
import { HealthSampleDeletionQueueService } from "./healthSampleDeletionQueueService.js";
import { FHIRObservationStatus } from "../../models/index.js";
import { describeWithEmulators } from "../../tests/functions/testEnvironment.js";

describeWithEmulators("service: HealthSampleDeletionQueueService", (env) => {
  let queueService: HealthSampleDeletionQueueService;

  beforeEach(() => {
    queueService = new HealthSampleDeletionQueueService(env.firestore);
  });

  afterEach(() => {
    restore();
  });

  describe("enqueue", () => {
    it("should add an item to the pending deletions collection at a deterministic doc id", async () => {
      await queueService.enqueue({
        userId: "user1",
        collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
        documentId: "doc1",
        jobId: "job1",
        requestingUserId: "user1",
        reason: "NOT_FOUND",
        lastError: "Error: 5 NOT_FOUND",
      });

      const snapshot = await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(snapshot.size).to.equal(1);
      expect(snapshot.docs[0].id).to.equal(
        "HealthObservations_HKQuantityTypeIdentifierHeartRate__doc1",
      );

      const data = snapshot.docs[0].data();
      expect(data.userId).to.equal("user1");
      expect(data.collection).to.equal(
        "HealthObservations_HKQuantityTypeIdentifierHeartRate",
      );
      expect(data.documentId).to.equal("doc1");
      expect(data.jobId).to.equal("job1");
      expect(data.reason).to.equal("NOT_FOUND");
      expect(data.retryCount).to.equal(0);
      expect(data.lastError).to.equal("UNKNOWN_ERROR");
    });

    it("should be idempotent on re-enqueue and preserve worker-managed retry state", async () => {
      // Pre-seed a pending doc with worker-advanced retry state, mimicking
      // what processQueueItem would write after several failed attempts.
      const pendingId =
        "HealthObservations_HKQuantityTypeIdentifierHeartRate__doc1";
      const advancedNextRetry = Timestamp.fromMillis(
        Date.now() + 5 * 60 * 1000,
      );
      await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .doc(pendingId)
        .set({
          userId: "user1",
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "doc1",
          jobId: "originalJob",
          requestingUserId: "user1",
          reason: "TRANSIENT_ERROR",
          lastError: "DEADLINE_EXCEEDED",
          retryCount: 3,
          createdAt: Timestamp.now(),
          nextRetryAt: advancedNextRetry,
        });

      // Re-enqueue the same target sample from a different job — this is the
      // duplicate path that previously created a new random-id doc on every call.
      await queueService.enqueue({
        userId: "user1",
        collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
        documentId: "doc1",
        jobId: "secondJob",
        requestingUserId: "user1",
        reason: "NOT_FOUND",
        lastError: "Error: 5 NOT_FOUND",
      });

      const snapshot = await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(snapshot.size).to.equal(1);
      expect(snapshot.docs[0].id).to.equal(pendingId);

      const data = snapshot.docs[0].data();
      // Worker-managed fields must NOT be reset by the re-enqueue.
      expect(data.retryCount).to.equal(3);
      expect(data.lastError).to.equal("DEADLINE_EXCEEDED");
      expect(data.reason).to.equal("TRANSIENT_ERROR");
      expect(data.jobId).to.equal("originalJob");
      expect((data.nextRetryAt as Timestamp).toMillis()).to.equal(
        advancedNextRetry.toMillis(),
      );
    });

    it("should set nextRetryAt 8h in the future for NOT_FOUND", async () => {
      const before = Timestamp.now().toMillis();
      const eightHoursMs = 8 * 60 * 60 * 1000;

      await queueService.enqueue({
        userId: "user1",
        collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
        documentId: "doc1",
        jobId: "job1",
        requestingUserId: "user1",
        reason: "NOT_FOUND",
        lastError: null,
      });

      const snapshot = await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .get();
      const data = snapshot.docs[0].data();
      const nextRetryMs = (data.nextRetryAt as Timestamp).toMillis();
      expect(nextRetryMs).to.be.greaterThanOrEqual(before + eightHoursMs);
      expect(nextRetryMs).to.be.lessThanOrEqual(before + eightHoursMs + 2_000);
    });

    it("should set nextRetryAt 8h in the future for TRANSIENT_ERROR", async () => {
      const before = Timestamp.now().toMillis();
      const eightHoursMs = 8 * 60 * 60 * 1000;

      await queueService.enqueue({
        userId: "user1",
        collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
        documentId: "doc1",
        jobId: "job1",
        requestingUserId: "user1",
        reason: "TRANSIENT_ERROR",
        lastError: "Error: 4 DEADLINE_EXCEEDED",
      });

      const snapshot = await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .get();
      const data = snapshot.docs[0].data();
      const nextRetryMs = (data.nextRetryAt as Timestamp).toMillis();
      expect(nextRetryMs).to.be.greaterThanOrEqual(before + eightHoursMs);
      expect(nextRetryMs).to.be.lessThanOrEqual(before + eightHoursMs + 2_000);
    });
  });

  describe("processQueue", () => {
    const stubTargetUpdateRejection = (
      error: Error & { code: number },
    ): void => {
      const updateStub = stub(DocumentReference.prototype, "update");
      updateStub.callsFake(function (
        this: DocumentReference,
        ...args: Parameters<DocumentReference["update"]>
      ): ReturnType<DocumentReference["update"]> {
        if (
          this.path.includes(
            "/HealthObservations_HKQuantityTypeIdentifierHeartRate/",
          ) &&
          !this.path.includes("/pendingHealthSampleDeletions/")
        ) {
          return Promise.reject(error);
        }
        return updateStub.wrappedMethod.apply(this, args);
      });
    };

    it("should return zeros when queue is empty", async () => {
      const result = await queueService.processQueue();
      expect(result.processed).to.equal(0);
      expect(result.succeeded).to.equal(0);
      expect(result.requeued).to.equal(0);
      expect(result.deadLettered).to.equal(0);
    });

    it("should successfully process a queued item when the document exists", async () => {
      const userId = await env.createUser({});

      // Create the target document
      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("HealthObservations_HKQuantityTypeIdentifierHeartRate")
        .doc("doc1")
        .set({ status: "final", value: 72 });

      // Enqueue with a past nextRetryAt so it's ready to process
      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("pendingHealthSampleDeletions")
        .add({
          userId,
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "doc1",
          jobId: "job1",
          requestingUserId: userId,
          reason: "NOT_FOUND",
          lastError: null,
          retryCount: 0,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(0),
        });

      const result = await queueService.processQueue();
      expect(result.succeeded).to.equal(1);
      expect(result.processed).to.equal(1);

      // Verify the document was updated
      const doc = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("HealthObservations_HKQuantityTypeIdentifierHeartRate")
        .doc("doc1")
        .get();
      expect(doc.data()?.status).to.equal(
        FHIRObservationStatus.entered_in_error,
      );

      // Verify the queue item was removed
      const queueSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(queueSnapshot.size).to.equal(0);
    });

    it("should requeue a NOT_FOUND target so a late-arriving sample can be retried", async () => {
      // The target sample doesn't exist yet — could be a deletion request that
      // raced ahead of the upload. The worker should retry, not short-circuit.
      await env.firestore
        .collection("users")
        .doc("nonexistent-user")
        .collection("pendingHealthSampleDeletions")
        .add({
          userId: "nonexistent-user",
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "nonexistent-doc",
          jobId: "job1",
          requestingUserId: "user1",
          reason: "NOT_FOUND",
          lastError: null,
          retryCount: 0,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(0),
        });

      const result = await queueService.processQueue();
      expect(result.requeued).to.equal(1);
      expect(result.succeeded).to.equal(0);
      expect(result.deadLettered).to.equal(0);

      const queueSnapshot = await env.firestore
        .collection("users")
        .doc("nonexistent-user")
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(queueSnapshot.size).to.equal(1);
      const data = queueSnapshot.docs[0].data();
      expect(data.retryCount).to.equal(1);
      expect(data.lastError).to.equal("NOT_FOUND");
    });

    it("should requeue with incremented retryCount on transient error", async () => {
      const userId = await env.createUser({});

      // Create the target sample so the only failure path is the stubbed one.
      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("HealthObservations_HKQuantityTypeIdentifierHeartRate")
        .doc("doc1")
        .set({ status: "final", value: 72 });

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("pendingHealthSampleDeletions")
        .add({
          userId,
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "doc1",
          jobId: "job1",
          requestingUserId: userId,
          reason: "TRANSIENT_ERROR",
          lastError: "Error: 14 UNAVAILABLE",
          retryCount: 0,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(0),
        });

      // Fail only the worker's update against the target sample; let
      // pending-doc retry-state writebacks proceed normally.
      const transientError = new Error("UNAVAILABLE") as Error & {
        code: number;
      };
      transientError.code = 14;
      stubTargetUpdateRejection(transientError);

      const result = await queueService.processQueue();
      expect(result.requeued).to.equal(1);
      expect(result.succeeded).to.equal(0);

      const queueSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(queueSnapshot.size).to.equal(1);
      const data = queueSnapshot.docs[0].data();
      expect(data.retryCount).to.equal(1);
      expect(data.lastError).to.equal("UNAVAILABLE");
    });

    it("should move item to dead-letter after max retries on transient errors", async () => {
      const userId = await env.createUser({});

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("HealthObservations_HKQuantityTypeIdentifierHeartRate")
        .doc("doc1")
        .set({ status: "final", value: 72 });

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("pendingHealthSampleDeletions")
        .add({
          userId,
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "doc1",
          jobId: "job1",
          requestingUserId: userId,
          reason: "TRANSIENT_ERROR",
          lastError: "Error: 4 DEADLINE_EXCEEDED",
          retryCount: 2,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(0),
        });

      const transientError = new Error("DEADLINE_EXCEEDED") as Error & {
        code: number;
      };
      transientError.code = 4;
      stubTargetUpdateRejection(transientError);

      const result = await queueService.processQueue();
      expect(result.deadLettered).to.equal(1);

      const pendingSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(pendingSnapshot.size).to.equal(0);

      // Final-attempt failures are dropped, not persisted indefinitely.
      const failedSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("failedHealthSampleDeletions")
        .get();
      expect(failedSnapshot.size).to.equal(0);
    });

    it("should skip items where payload userId does not match path owner", async () => {
      // Create queue doc under user1 but payload says user2
      await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .add({
          userId: "user2",
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "doc1",
          jobId: "job1",
          requestingUserId: "user1",
          reason: "NOT_FOUND",
          lastError: null,
          retryCount: 0,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(0),
        });

      const result = await queueService.processQueue();
      expect(result.skipped).to.equal(1);
      expect(result.succeeded).to.equal(0);

      // Verify the invalid item was removed from queue
      const snapshot = await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(snapshot.size).to.equal(0);
    });

    it("should skip items with disallowed collection name", async () => {
      await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .add({
          userId: "user1",
          collection: "../../admin/secrets",
          documentId: "doc1",
          jobId: "job1",
          requestingUserId: "user1",
          reason: "NOT_FOUND",
          lastError: null,
          retryCount: 0,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(0),
        });

      const result = await queueService.processQueue();
      expect(result.skipped).to.equal(1);
      expect(result.succeeded).to.equal(0);
    });

    it("should skip items with invalid documentId containing path separator", async () => {
      await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .add({
          userId: "user1",
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "../../otherCollection/otherDoc",
          jobId: "job1",
          requestingUserId: "user1",
          reason: "NOT_FOUND",
          lastError: null,
          retryCount: 0,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(0),
        });

      const result = await queueService.processQueue();
      expect(result.skipped).to.equal(1);
      expect(result.succeeded).to.equal(0);
    });

    it("should not process items with future nextRetryAt", async () => {
      await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .add({
          userId: "user1",
          collection: "HealthObservations_HKQuantityTypeIdentifierHeartRate",
          documentId: "doc1",
          jobId: "job1",
          requestingUserId: "user1",
          reason: "NOT_FOUND",
          lastError: null,
          retryCount: 0,
          createdAt: Timestamp.now(),
          nextRetryAt: Timestamp.fromMillis(Date.now() + 3_600_000),
        });

      const result = await queueService.processQueue();
      expect(result.processed).to.equal(0);

      // Item should still be in queue
      const snapshot = await env.firestore
        .collection("users")
        .doc("user1")
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(snapshot.size).to.equal(1);
    });
  });
});
