// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import admin from "firebase-admin";
import type { https } from "firebase-functions/v2";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";
import { expectError } from "../tests/helpers.js";
import { deleteHealthSamples } from "./deleteHealthSamples.js";

describeWithEmulators(
  "function: deleteHealthSamples (FHIR compliant)",
  (env) => {
    it("should accept requests without confirmation parameter", async () => {
      const userId = await env.createUser({});

      const result = await env.call(
        deleteHealthSamples,
        {
          userId,
          collection: "heartRateObservations",
          documentIds: ["test-id"],
        },
        { uid: userId },
      );

      expect(result.status).to.equal("accepted");
      expect(result.jobId).to.be.a("string");
      expect(result.totalSamples).to.equal(1);
    });

    it("should validate empty samples array", async () => {
      const userId = await env.createUser({});

      await expectError(
        () =>
          env.call(
            deleteHealthSamples,
            {
              userId,
              collection: "heartRateObservations",
              documentIds: [],
            },
            { uid: userId },
          ),
        (error) => {
          const httpsError = error as https.HttpsError;
          expect(httpsError.code).to.equal("invalid-argument");
        },
      );
    });

    it("should validate too many samples", async () => {
      const userId = await env.createUser({});

      const tooManyDocumentIds = Array.from(
        { length: 50001 },
        (_, i) => `test-id-${i}`,
      );

      await expectError(
        () =>
          env.call(
            deleteHealthSamples,
            {
              userId,
              collection: "heartRateObservations",
              documentIds: tooManyDocumentIds,
            },
            { uid: userId },
          ),
        (error) => {
          const httpsError = error as https.HttpsError;
          expect(httpsError.code).to.equal("invalid-argument");
        },
      );
    });

    it("should return async job response for entered-in-error marking", async () => {
      const userId = await env.createUser({});

      const result = await env.call(
        deleteHealthSamples,
        {
          userId,
          collection: "heartRateObservations",
          documentIds: ["non-existent"],
        },
        { uid: userId },
      );

      expect(result.status).to.equal("accepted");
      expect(result.jobId).to.be.a("string");
      expect(result.totalSamples).to.equal(1);
      expect(result.message).to.include("Marking job completed.");
      expect(result.message).to.include("out of 1 samples");
    });

    it("should deny access to other users samples", async () => {
      const userId1 = await env.createUser({});
      const userId2 = await env.createUser({});

      await expectError(
        () =>
          env.call(
            deleteHealthSamples,
            {
              userId: userId2,
              collection: "heartRateObservations",
              documentIds: ["test-id"],
            },
            { uid: userId1 },
          ),
        (error) => {
          const httpsError = error as https.HttpsError;
          expect(httpsError.code).to.equal("permission-denied");
        },
      );
    });

    it("should queue NOT_FOUND documents to pendingHealthSampleDeletions", async () => {
      const userId = await env.createUser({});

      await env.call(
        deleteHealthSamples,
        {
          userId,
          collection: "heartRateObservations",
          documentIds: ["non-existent-doc"],
        },
        { uid: userId },
      );

      const snapshot = await admin
        .firestore()
        .collection("users")
        .doc(userId)
        .collection("pendingHealthSampleDeletions")
        .get();
      expect(snapshot.size).to.equal(1);

      const data = snapshot.docs[0].data();
      expect(data.userId).to.equal(userId);
      expect(data.collection).to.equal("heartRateObservations");
      expect(data.documentId).to.equal("non-existent-doc");
      expect(data.reason).to.equal("NOT_FOUND");
    });

    it("should handle large batch marking requests", async () => {
      const userId = await env.createUser({});

      // Create a large batch of 1000 document IDs
      const largeBatchDocumentIds = Array.from(
        { length: 1000 },
        (_, i) => `large-batch-sample-${i}`,
      );

      const result = await env.call(
        deleteHealthSamples,
        {
          userId,
          collection: "heartRateObservations",
          documentIds: largeBatchDocumentIds,
        },
        { uid: userId },
      );

      expect(result.status).to.equal("accepted");
      expect(result.jobId).to.be.a("string");
      expect(result.totalSamples).to.equal(1000);
      expect(result.message).to.include("Marking job completed.");
      expect(result.message).to.include("out of 1000 samples");
    });
  },
);
