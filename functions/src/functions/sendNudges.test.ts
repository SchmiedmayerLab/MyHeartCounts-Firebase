// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import admin from "firebase-admin";
import { it, describe } from "mocha";
import { stub, restore } from "sinon";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";
import { MockMessaging } from "../tests/mocks/messaging.js";
import { processNotificationBacklog } from "./sendNudges.js";

describeWithEmulators("function: sendNudges", (env) => {
  let mockMessaging: MockMessaging;

  beforeEach(() => {
    mockMessaging = new MockMessaging();
    // Stub the messaging function directly on the admin object
    // this prevents actual firebase calls in tests
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    stub(admin, "messaging").returns(mockMessaging as any);
  });

  afterEach(() => {
    restore();
  });
  describe("Notification processing", () => {
    it("does not send notifications when time has not passed", async () => {
      const userId = "test-user-future";
      const futureTime = new Date();
      futureTime.setMinutes(futureTime.getMinutes() + 30);

      await env.firestore.collection("users").doc(userId).set({
        fcmToken: "test-fcm-token",
        timeZone: "UTC",
      });

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .add({
          title: "Future Notification",
          body: "This notification is for the future",
          timestamp: admin.firestore.Timestamp.fromDate(futureTime),
        });

      await processNotificationBacklog();

      const historySnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationHistory")
        .get();

      expect(historySnapshot.size).to.equal(0);

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(1);
    });

    it("archives failed notifications for users without FCM token", async () => {
      const userId = "test-user-no-token";
      const pastTime = new Date();
      pastTime.setMinutes(pastTime.getMinutes() - 30);

      await env.firestore.collection("users").doc(userId).set({
        timeZone: "UTC",
      });

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .add({
          title: "Test Notification",
          body: "This notification should not be sent",
          timestamp: admin.firestore.Timestamp.fromDate(pastTime),
        });

      await processNotificationBacklog();

      const historySnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationHistory")
        .get();

      expect(historySnapshot.size).to.equal(1);

      const archivedNotification = historySnapshot.docs[0].data();
      expect(archivedNotification.status).to.equal("failed");
      expect(archivedNotification.errorMessage).to.equal(
        "No FCM token available for user",
      );
      expect(archivedNotification.title).to.equal("Test Notification");
      expect(archivedNotification.body).to.equal(
        "This notification should not be sent",
      );

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(0);
    });

    it("skips users without timezone", async () => {
      const userId = "test-user-no-timezone";
      const pastTime = new Date();
      pastTime.setMinutes(pastTime.getMinutes() - 30);

      await env.firestore.collection("users").doc(userId).set({
        fcmToken: "test-fcm-token",
      });

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .add({
          title: "Test Notification",
          body: "This notification should not be sent",
          timestamp: admin.firestore.Timestamp.fromDate(pastTime),
        });

      await processNotificationBacklog();

      const historySnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationHistory")
        .get();

      expect(historySnapshot.size).to.equal(0);

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(1);
    });

    it("archives notifications when FCM token exists", async () => {
      const userId = "test-user-success";
      const pastTime = new Date();
      pastTime.setMinutes(pastTime.getMinutes() - 30);

      await env.firestore.collection("users").doc(userId).set({
        fcmToken: "test-success-token",
        timeZone: "UTC",
      });

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .add({
          title: "Success Notification",
          body: "This notification should be sent successfully",
          timestamp: admin.firestore.Timestamp.fromDate(pastTime),
        });

      await processNotificationBacklog();

      const historySnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationHistory")
        .get();

      expect(historySnapshot.size).to.equal(1);

      const archivedNotification = historySnapshot.docs[0].data();
      expect(archivedNotification.status).to.equal("failed"); // Firebase throws error for mock token
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(archivedNotification.errorMessage).to.exist; // Error message varies by environment
      expect(archivedNotification.title).to.equal("Success Notification");
      expect(archivedNotification.body).to.equal(
        "This notification should be sent successfully",
      );

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(0);
    });

    it("archives failed notifications with error status", async () => {
      const userId = "test-user-fail";
      const pastTime = new Date();
      pastTime.setMinutes(pastTime.getMinutes() - 30);

      await env.firestore.collection("users").doc(userId).set({
        fcmToken: "test-fail-token", // Mock will fail tokens with 'fail' in name
        timeZone: "UTC",
      });

      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .add({
          title: "Fail Notification",
          body: "This notification should fail",
          timestamp: admin.firestore.Timestamp.fromDate(pastTime),
        });

      await processNotificationBacklog();

      const historySnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationHistory")
        .get();

      expect(historySnapshot.size).to.equal(1);

      const archivedNotification = historySnapshot.docs[0].data();
      expect(archivedNotification.status).to.equal("failed");
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(archivedNotification.errorMessage).to.exist; // Error message varies by environment
      expect(archivedNotification.title).to.equal("Fail Notification");
      expect(archivedNotification.body).to.equal(
        "This notification should fail",
      );

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(0);
    });
  });

  describe("Error handling", () => {
    it("handles empty notification backlog gracefully", async () => {
      const userId = "test-user-empty";

      await env.firestore.collection("users").doc(userId).set({
        fcmToken: "test-fcm-token",
        timeZone: "UTC",
      });

      await processNotificationBacklog();

      const historySnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationHistory")
        .get();

      expect(historySnapshot.size).to.equal(0);
    });

    it("handles users with no backlog collection", async () => {
      const userId = "test-user-no-backlog";

      await env.firestore.collection("users").doc(userId).set({
        fcmToken: "test-fcm-token",
        timeZone: "UTC",
      });

      await processNotificationBacklog();

      const historySnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationHistory")
        .get();

      expect(historySnapshot.size).to.equal(0);
    });
  });
});
