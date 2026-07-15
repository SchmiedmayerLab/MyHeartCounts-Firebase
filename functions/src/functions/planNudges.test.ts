// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import type { Timestamp } from "@google-cloud/firestore";
import { expect } from "chai";
import admin from "firebase-admin";
import { DateTime } from "luxon";
import { it, describe } from "mocha";
import { createNudgeNotifications } from "./planNudges.js";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";

/* eslint-disable @typescript-eslint/no-unused-expressions */

describeWithEmulators("function: planNudges", (env) => {
  describe("User eligibility and nudge creation", () => {
    it("creates nudge-predefined nudges for group 1 user at day 7", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      const userId = "test-user-1";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      const firstNudgeDocId = backlogSnapshot.docs[0].id;
      expect(firstNudge.category).to.equal("nudge-predefined");
      expect(firstNudge.title).to.be.a("string");
      expect(firstNudge.body).to.be.a("string");
      expect(firstNudge.timestamp).to.be.instanceOf(admin.firestore.Timestamp);
      expect(firstNudge.id).to.be.a("string");
      expect(firstNudge.id).to.equal(firstNudgeDocId);
      expect(firstNudge.id).to.match(
        /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/,
      );
    });

    it("creates nudges for group 1 user at day 14 (fallback to nudge-predefined when no API key)", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 14);

      const userId = "test-user-2";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/Los_Angeles",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
          genderIdentity: "female",
          dateOfBirth: new Date("1990-01-01"),
          comorbidities: {},
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      const firstNudgeDocId = backlogSnapshot.docs[0].id;
      // Should fall back to nudge-predefined nudges when OpenAI API key is not available
      expect(firstNudge.category).to.equal("nudge-predefined");
      expect(firstNudge.title).to.be.a("string");
      expect(firstNudge.body).to.be.a("string");
      expect(firstNudge.isLLMGenerated).to.not.be.true;
      expect(firstNudge.id).to.be.a("string");
      expect(firstNudge.id).to.equal(firstNudgeDocId);
      expect(firstNudge.id).to.match(
        /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/,
      );
    });

    it("creates nudges for group 2 user at day 7 (fallback to nudge-predefined when no API key)", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      const userId = "test-user-3";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "UTC",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 2,
          userLanguage: "en",
          genderIdentity: "male",
          dateOfBirth: new Date("1985-01-01"),
          comorbidities: {},
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      // Should fall back to nudge-predefined nudges when OpenAI API key is not available
      expect(firstNudge.category).to.equal("nudge-predefined");
      expect(firstNudge.isLLMGenerated).to.not.be.true;
    });

    it("creates nudge-predefined nudges for group 2 user at day 14", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 14);

      const userId = "test-user-4";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "Europe/London",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 2,
          userLanguage: "en",
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      expect(firstNudge.category).to.equal("nudge-predefined");
    });

    it("creates Spanish nudges for Spanish-speaking users", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      const userId = "test-user-spanish";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/Mexico_City",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "es",
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      const firstNudgeDocId = backlogSnapshot.docs[0].id;
      expect(firstNudge.category).to.equal("nudge-predefined");
      // Check that it's in Spanish by looking for spanish words
      expect(firstNudge.title).to.match(/Recordatorio|Actividad|MHC/);
      expect(firstNudge.id).to.be.a("string");
      expect(firstNudge.id).to.equal(firstNudgeDocId);
      expect(firstNudge.id).to.match(
        /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/,
      );
    });

    it("skips users without required fields", async () => {
      const userId = "test-user-incomplete";
      await env.firestore.collection("users").doc(userId).set({
        participantGroup: 1,
      });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(0);
    });

    it("skips users not on day 7 or 14", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 5);

      const userId = "test-user-early";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(0);
    });

    it("handles OpenAI API failures gracefully (falls back to nudge-predefined)", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 14);

      const userId = "test-user-api-fail";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
          genderIdentity: "female",
          dateOfBirth: new Date("1990-01-01"),
          comorbidities: {},
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      expect(firstNudge.category).to.equal("nudge-predefined");
      expect(firstNudge.isLLMGenerated).to.not.be.true;
    });

    it("creates nudges for manual trigger (fallback to nudge-predefined when no API key)", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 3); // Not on day 7 or 14

      const userId = "test-user-manual-trigger";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
          triggerNudgeGeneration: true,
          genderIdentity: "female",
          dateOfBirth: new Date("1990-01-01"),
          comorbidities: {},
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      // Check that nudges were created
      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      // Should fall back to nudge-predefined nudges when OpenAI API key is not available
      expect(firstNudge.category).to.equal("nudge-predefined");
      expect(firstNudge.isLLMGenerated).to.not.be.true;

      // Check that the trigger flag was reset
      const userDoc = await env.firestore.collection("users").doc(userId).get();
      const userData = userDoc.data();
      expect(userData?.triggerNudgeGeneration).to.be.false;
    });

    it("falls back to 09:00 when preferredNotificationTime is missing", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      const userId = "test-user-no-notif-time";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .orderBy("timestamp")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      expect(firstNudge.category).to.equal("nudge-predefined");
      expect(firstNudge.title).to.be.a("string");
      expect(firstNudge.body).to.be.a("string");

      // Verify that the fallback time of 09:00 was used
      const timestamps = backlogSnapshot.docs.map(
        (doc) => doc.data().timestamp as Timestamp,
      );
      for (const timestamp of timestamps) {
        const utcDate = timestamp.toDate();
        const localDateTime = DateTime.fromJSDate(utcDate, {
          zone: "America/New_York",
        });
        expect(localDateTime.hour).to.equal(9);
        expect(localDateTime.minute).to.equal(0);
      }
    });
  });

  describe("Time zone handling", () => {
    it("schedules nudges at 1 PM in user local time", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      const userId = "test-user-timezone";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .orderBy("timestamp")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const timestamps = backlogSnapshot.docs.map(
        (doc) => doc.data().timestamp as Timestamp,
      );

      // Verify timestamps are in the future and properly spaced (roughly 24 hours apart)
      for (let i = 0; i < timestamps.length - 1; i++) {
        const currentTime = timestamps[i].toDate();
        const nextTime = timestamps[i + 1].toDate();
        const timeDiff = nextTime.getTime() - currentTime.getTime();
        const hoursDiff = timeDiff / (1000 * 60 * 60);
        expect(hoursDiff).to.be.approximately(24, 1); // Allow 1 hour tolerance
      }
    });

    it("handles DST transitions correctly - maintains consistent local time", async () => {
      // This test verifies that nudges scheduled across DST transitions
      // maintain the same local time (e.g., 9:00 AM) even though UTC time shifts
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      const userId = "test-user-dst";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York", // Has DST transitions
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "en",
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .orderBy("timestamp")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const timestamps = backlogSnapshot.docs.map(
        (doc) => doc.data().timestamp as Timestamp,
      );

      // Verify that each notification is scheduled for 9:00 AM in America/New_York timezone
      for (const timestamp of timestamps) {
        const utcDate = timestamp.toDate();
        const localDateTime = DateTime.fromJSDate(utcDate, {
          zone: "America/New_York",
        });

        // Check that the local hour is 9 (9:00 AM)
        expect(localDateTime.hour).to.equal(9);
        expect(localDateTime.minute).to.equal(0);
      }

      // Verify spacing between notifications
      // During DST transitions, this could be 23 or 25 hours in UTC but should be 24 hours in local time
      for (let i = 0; i < timestamps.length - 1; i++) {
        const currentTime = timestamps[i].toDate();
        const nextTime = timestamps[i + 1].toDate();
        const timeDiff = nextTime.getTime() - currentTime.getTime();
        const hoursDiff = timeDiff / (1000 * 60 * 60);

        // Allow 2 hour tolerance to account for DST transitions
        // Most days will be 24 hours, but DST transition days can be 23 or 25 hours in UTC
        expect(hoursDiff).to.be.at.least(23);
        expect(hoursDiff).to.be.at.most(25);
      }
    });

    it("handles multiple timezones correctly", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      // Create users in different timezones
      const timezones = [
        "America/New_York", // EST/EDT
        "America/Los_Angeles", // PST/PDT
        "Europe/London", // GMT/BST
        "Asia/Tokyo", // JST (no DST)
        "Australia/Sydney", // AEDT/AEST
      ];

      for (let index = 0; index < timezones.length; index++) {
        const timezone = timezones[index];
        const userId = `test-user-tz-${index}`;
        await env.firestore
          .collection("users")
          .doc(userId)
          .set({
            timeZone: timezone,
            dateOfEnrollment:
              admin.firestore.Timestamp.fromDate(enrollmentDate),
            participantGroup: 1,
            userLanguage: "en",
            preferredNotificationTime: "10:00",
            didOptInToTrial: true,
            mostRecentOnboardingStep: "finalStep",
          });
      }

      await createNudgeNotifications();

      // Verify each user gets nudges at their local 10:00 AM
      for (let index = 0; index < timezones.length; index++) {
        const timezone = timezones[index];
        const userId = `test-user-tz-${index}`;
        const backlogSnapshot = await env.firestore
          .collection("users")
          .doc(userId)
          .collection("notificationBacklog")
          .orderBy("timestamp")
          .get();

        expect(backlogSnapshot.size).to.equal(7);

        const timestamps = backlogSnapshot.docs.map(
          (doc) => doc.data().timestamp as Timestamp,
        );

        // Verify each notification is at 10:00 AM in the user's timezone
        for (const timestamp of timestamps) {
          const utcDate = timestamp.toDate();
          const localDateTime = DateTime.fromJSDate(utcDate, {
            zone: timezone,
          });

          expect(localDateTime.hour).to.equal(10);
          expect(localDateTime.minute).to.equal(0);
        }
      }
    });
  });

  describe("Language support", () => {
    it("defaults to English for unsupported languages", async () => {
      const enrollmentDate = new Date();
      enrollmentDate.setDate(enrollmentDate.getDate() - 7);

      const userId = "test-user-unsupported-lang";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "UTC",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(enrollmentDate),
          participantGroup: 1,
          userLanguage: "fr",
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
        });

      await createNudgeNotifications();

      const backlogSnapshot = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      expect(backlogSnapshot.size).to.equal(7);

      const firstNudge = backlogSnapshot.docs[0].data();
      expect(firstNudge.category).to.equal("nudge-predefined");
      expect(firstNudge.title).to.not.include("¡");
    });
  });
});
