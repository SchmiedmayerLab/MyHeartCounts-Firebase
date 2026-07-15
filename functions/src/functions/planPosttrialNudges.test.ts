// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { expect } from "chai";
import admin from "firebase-admin";
import { DateTime } from "luxon";
import { it, describe } from "mocha";
import { createNudgeNotifications } from "./planNudges.js";
import {
  PosttrialNudgeService,
  createPosttrialNudgeNotifications,
} from "./planPosttrialNudges.js";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";

const daysAgo = (days: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
};

const baseEligibleUser = (overrides: Record<string, unknown> = {}) => ({
  timeZone: "America/New_York",
  dateOfEnrollment: admin.firestore.Timestamp.fromDate(daysAgo(22)),
  lastActiveDate: admin.firestore.Timestamp.fromDate(daysAgo(1)),
  participantGroup: 1,
  userLanguage: "en",
  preferredNotificationTime: "09:00",
  didOptInToTrial: true,
  mostRecentOnboardingStep: "finalStep",
  extendedActivityNudgesOptIn: true,
  ...overrides,
});

describeWithEmulators("function: planPosttrialNudges", (env) => {
  describe("Eligibility — skip paths", () => {
    it("skips users with extendedActivityNudgesOptIn=false", async () => {
      const userId = "posttrial-skip-opt-out";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser({ extendedActivityNudgesOptIn: false }));

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });

    it("skips users whose trial is not yet complete (< 21 days since enrollment)", async () => {
      const userId = "posttrial-skip-too-early";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(
          baseEligibleUser({
            dateOfEnrollment: admin.firestore.Timestamp.fromDate(daysAgo(20)),
          }),
        );

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });

    it("skips users whose lastActiveDate is older than 14 days", async () => {
      const userId = "posttrial-skip-inactive";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(
          baseEligibleUser({
            lastActiveDate: admin.firestore.Timestamp.fromDate(daysAgo(20)),
          }),
        );

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });

    it("skips users with didOptInToTrial=false", async () => {
      const userId = "posttrial-skip-no-trial-optin";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser({ didOptInToTrial: false }));

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });

    it("skips users whose onboarding is not complete", async () => {
      const userId = "posttrial-skip-onboarding";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser({ mostRecentOnboardingStep: "demographics" }));

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });

    it("skips disabled users", async () => {
      const userId = "posttrial-skip-disabled";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser({ disabled: true }));

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });

    it("skips users who have withdrawn from the study", async () => {
      const userId = "posttrial-skip-withdrawn";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser({ hasWithdrawnFromStudy: true }));

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });
  });

  describe("LLM failure — no fallback", () => {
    it("creates 0 nudges when the OpenAI call fails (no predefined fallback)", async () => {
      const userId = "posttrial-llm-failure";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(
          baseEligibleUser({
            genderIdentity: "female",
            dateOfBirth: new Date("1990-01-01"),
            comorbidities: {},
            preferredWorkoutTypes: "HIIT,walk,strength,yoga/pilates,bicycle",
          }),
        );

      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      // No API key in the emulator → generateLLMNudge returns null after
      // retries → user is skipped for the day with no predefined fallback.
      expect(backlog.size).to.equal(0);
    });
  });

  describe("Deduplication", () => {
    it("does not create a duplicate nudge if one already exists for the target local day", async () => {
      const userId = "posttrial-dedup";
      const userData = baseEligibleUser({
        timeZone: "UTC",
        preferredNotificationTime: "09:00",
      });
      await env.firestore.collection("users").doc(userId).set(userData);

      // Pre-seed a nudge-posttrial backlog doc for the same upcoming local
      // day the function would target (= "next upcoming 09:00 UTC slot").
      const nowUtc = DateTime.utc();
      let target = nowUtc.set({
        hour: 9,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
      if (target <= nowUtc) {
        target = target.plus({ days: 1 });
      }
      const preSeedId = randomUUID().toUpperCase();
      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .doc(preSeedId)
        .set({
          id: preSeedId,
          title: "Pre-seeded",
          body: "Pre-seeded post-trial nudge",
          timestamp: admin.firestore.Timestamp.fromDate(target.toJSDate()),
          category: "nudge-posttrial",
          isLLMGenerated: true,
          generatedAt: admin.firestore.Timestamp.now(),
        });

      await createPosttrialNudgeNotifications();

      // Still exactly the one pre-seeded doc — dedup prevented a second
      // write (and no LLM call was made).
      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(1);
      expect(backlog.docs[0].id).to.equal(preSeedId);
    });
  });

  describe("Coexistence with planNudges", () => {
    it("planNudges (day 7) user is untouched by planPosttrialNudges", async () => {
      const userId = "coexist-trial-user";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set({
          timeZone: "America/New_York",
          dateOfEnrollment: admin.firestore.Timestamp.fromDate(daysAgo(7)),
          lastActiveDate: admin.firestore.Timestamp.fromDate(daysAgo(1)),
          participantGroup: 1,
          userLanguage: "en",
          preferredNotificationTime: "09:00",
          didOptInToTrial: true,
          mostRecentOnboardingStep: "finalStep",
          extendedActivityNudgesOptIn: false, // explicit opt-out of posttrial
        });

      await createNudgeNotifications();
      await createPosttrialNudgeNotifications();

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();

      // Exactly the 7 trial-predefined nudges — posttrial added nothing
      // (neither a regular posttrial nudge nor a welcome nudge).
      expect(backlog.size).to.equal(7);
      for (const doc of backlog.docs) {
        const category = doc.data().category as string | undefined;
        expect(category).to.equal("nudge-predefined");
        expect(category).to.not.equal("nudge-posttrial");
        expect(category).to.not.equal("nudge-posttrial-welcome");
      }
    });

    it("a posttrial-eligible user (day 22) is untouched by planNudges", async () => {
      const userId = "coexist-posttrial-user";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(
          baseEligibleUser({
            genderIdentity: "female",
            dateOfBirth: new Date("1990-01-01"),
            comorbidities: {},
          }),
        );

      // planNudges runs first; user is past day 14 so no trial nudges
      // should be created for them.
      await createNudgeNotifications();

      const backlogAfterTrial = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlogAfterTrial.size).to.equal(0);
    });
  });

  describe("getRecentPosttrialNudgeBodies", () => {
    const seedBacklog = async (
      env: { firestore: admin.firestore.Firestore },
      userId: string,
      docs: Array<{ id?: string; body: string; ts: Date; category?: string }>,
    ): Promise<void> => {
      for (const doc of docs) {
        const id = doc.id ?? randomUUID().toUpperCase();
        await env.firestore
          .collection("users")
          .doc(userId)
          .collection("notificationBacklog")
          .doc(id)
          .set({
            id,
            title: "t",
            body: doc.body,
            timestamp: admin.firestore.Timestamp.fromDate(doc.ts),
            category: doc.category ?? "nudge-posttrial",
            isLLMGenerated: true,
          });
      }
    };

    const seedHistory = async (
      env: { firestore: admin.firestore.Firestore },
      userId: string,
      docs: Array<{
        id?: string;
        body: string;
        ts: Date;
        category?: string;
        status?: "sent" | "failed";
      }>,
    ): Promise<void> => {
      for (const doc of docs) {
        const id = doc.id ?? randomUUID().toUpperCase();
        await env.firestore
          .collection("users")
          .doc(userId)
          .collection("notificationHistory")
          .doc(id)
          .set({
            title: "t",
            body: doc.body,
            originalTimestamp: admin.firestore.Timestamp.fromDate(doc.ts),
            processedTimestamp: admin.firestore.FieldValue.serverTimestamp(),
            status: doc.status ?? "sent",
            category: doc.category ?? "nudge-posttrial",
            isLLMGenerated: true,
          });
      }
    };

    it("merges backlog and history, returning oldest-to-newest within limit", async () => {
      const userId = "posttrial-recent-merge";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser());

      const now = Date.now();
      const minutesAgo = (m: number) => new Date(now - m * 60_000);

      // 2 history (delivered): 60 and 30 minutes ago.
      await seedHistory(env, userId, [
        { body: "history-old", ts: minutesAgo(60) },
        { body: "history-mid", ts: minutesAgo(30) },
      ]);
      // 2 backlog: one 10 minutes ago (already due, not yet processed) and
      // one 60 minutes in the future (must be excluded by the < beforeUtc
      // filter).
      await seedBacklog(env, userId, [
        { body: "backlog-recent", ts: minutesAgo(10) },
        { body: "backlog-future", ts: new Date(now + 60 * 60_000) },
      ]);

      const service = new PosttrialNudgeService(env.firestore);
      const result = await service.getRecentPosttrialNudgeBodies(
        userId,
        new Date(now),
      );

      expect(result).to.deep.equal([
        "history-old",
        "history-mid",
        "backlog-recent",
      ]);
    });

    it("caps at the requested limit, preferring the most recent entries", async () => {
      const userId = "posttrial-recent-limit";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser());

      const now = Date.now();
      const daysAgoMs = (d: number) => new Date(now - d * 86_400_000);

      await seedHistory(env, userId, [
        { body: "5d", ts: daysAgoMs(5) },
        { body: "4d", ts: daysAgoMs(4) },
        { body: "3d", ts: daysAgoMs(3) },
        { body: "2d", ts: daysAgoMs(2) },
        { body: "1d", ts: daysAgoMs(1) },
      ]);

      const service = new PosttrialNudgeService(env.firestore);
      const result = await service.getRecentPosttrialNudgeBodies(
        userId,
        new Date(now),
      );

      // 3 most recent, returned oldest-first.
      expect(result).to.deep.equal(["3d", "2d", "1d"]);
    });

    it("dedupes when the same doc id exists in both collections (history wins)", async () => {
      const userId = "posttrial-recent-dedup";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser());

      const now = Date.now();
      const sharedId = "SHARED-DOC-ID";

      await seedHistory(env, userId, [
        { id: sharedId, body: "from-history", ts: new Date(now - 60_000) },
      ]);
      await seedBacklog(env, userId, [
        { id: sharedId, body: "from-backlog", ts: new Date(now - 60_000) },
      ]);

      const service = new PosttrialNudgeService(env.firestore);
      const result = await service.getRecentPosttrialNudgeBodies(
        userId,
        new Date(now),
      );

      expect(result).to.deep.equal(["from-history"]);
    });

    it("ignores entries from other categories (e.g. welcome, predefined)", async () => {
      const userId = "posttrial-recent-category-filter";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser());

      const now = Date.now();
      const minutesAgo = (m: number) => new Date(now - m * 60_000);

      await seedHistory(env, userId, [
        {
          body: "wrong-welcome",
          ts: minutesAgo(5),
          category: "nudge-posttrial-welcome",
        },
        {
          body: "wrong-predefined",
          ts: minutesAgo(4),
          category: "nudge-predefined",
        },
        { body: "right", ts: minutesAgo(3) },
      ]);
      await seedBacklog(env, userId, [
        {
          body: "wrong-welcome-bl",
          ts: minutesAgo(2),
          category: "nudge-posttrial-welcome",
        },
      ]);

      const service = new PosttrialNudgeService(env.firestore);
      const result = await service.getRecentPosttrialNudgeBodies(
        userId,
        new Date(now),
      );

      expect(result).to.deep.equal(["right"]);
    });

    it("returns an empty array when the user has no nudges", async () => {
      const userId = "posttrial-recent-empty";
      await env.firestore
        .collection("users")
        .doc(userId)
        .set(baseEligibleUser());

      const service = new PosttrialNudgeService(env.firestore);
      const result = await service.getRecentPosttrialNudgeBodies(
        userId,
        new Date(),
      );

      expect(result).to.deep.equal([]);
    });
  });

  describe("Welcome notification", () => {
    const WELCOME_TITLE = "Physical Activity Nudges Extended";
    const WELCOME_BODY =
      "Daily nudges for your preferred activities continue after trial! Manage anytime in Profile/Settings under long-term nudges toggle.";

    it("schedules the welcome nudge on first-time eligibility", async () => {
      const userId = "posttrial-welcome-first";
      const userData = baseEligibleUser();
      await env.firestore.collection("users").doc(userId).set(userData);

      const firstNudgeTarget = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const service = new PosttrialNudgeService(env.firestore);

      const scheduled = await service.scheduleWelcomeIfNeeded(
        userId,
        userData,
        firstNudgeTarget,
        "en",
      );

      expect(scheduled).to.equal(true);

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(1);

      const doc = backlog.docs[0].data();
      expect(doc.category).to.equal("nudge-posttrial-welcome");
      expect(doc.title).to.equal(WELCOME_TITLE);
      expect(doc.body).to.equal(WELCOME_BODY);
      expect(doc.isLLMGenerated).to.equal(false);

      const ts = doc.timestamp as admin.firestore.Timestamp;
      expect(ts.toDate().getTime()).to.equal(
        firstNudgeTarget.getTime() - 60 * 60 * 1000,
      );

      const userAfter = await env.firestore
        .collection("users")
        .doc(userId)
        .get();
      expect(userAfter.data()?.posttrialWelcomeNudgeScheduled).to.equal(true);
    });

    it("is idempotent when the flag is already set", async () => {
      const userId = "posttrial-welcome-idempotent";
      const userData = baseEligibleUser({
        posttrialWelcomeNudgeScheduled: true,
      });
      await env.firestore.collection("users").doc(userId).set(userData);

      const firstNudgeTarget = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const service = new PosttrialNudgeService(env.firestore);

      const scheduled = await service.scheduleWelcomeIfNeeded(
        userId,
        userData,
        firstNudgeTarget,
        "en",
      );

      expect(scheduled).to.equal(false);

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);
    });

    it("writes the welcome nudge timestamp exactly 1 hour before the first nudge", async () => {
      const userId = "posttrial-welcome-precision";
      const userData = baseEligibleUser();
      await env.firestore.collection("users").doc(userId).set(userData);

      // Pick an arbitrary future instant (not round-number) to prove
      // we're doing millisecond-precise arithmetic.
      const firstNudgeTarget = new Date(
        Date.now() + 17 * 60 * 60 * 1000 + 34 * 60 * 1000 + 27_000,
      );
      const service = new PosttrialNudgeService(env.firestore);

      await service.scheduleWelcomeIfNeeded(
        userId,
        userData,
        firstNudgeTarget,
        "en",
      );

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      const ts = backlog.docs[0].data().timestamp as admin.firestore.Timestamp;
      expect(ts.toDate().getTime()).to.equal(
        firstNudgeTarget.getTime() - 3_600_000,
      );
    });

    it("still schedules when the computed welcome time lands in the recent past", async () => {
      const userId = "posttrial-welcome-past";
      const userData = baseEligibleUser();
      await env.firestore.collection("users").doc(userId).set(userData);

      // Target only 30 minutes in the future → welcome = target − 1 h is 30
      // minutes in the past. sendNudges will deliver it on its next poll.
      const firstNudgeTarget = new Date(Date.now() + 30 * 60 * 1000);
      const service = new PosttrialNudgeService(env.firestore);

      const scheduled = await service.scheduleWelcomeIfNeeded(
        userId,
        userData,
        firstNudgeTarget,
        "en",
      );

      expect(scheduled).to.equal(true);

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(1);

      const ts = backlog.docs[0].data().timestamp as admin.firestore.Timestamp;
      expect(ts.toDate().getTime()).to.be.lessThan(Date.now());

      const userAfter = await env.firestore
        .collection("users")
        .doc(userId)
        .get();
      expect(userAfter.data()?.posttrialWelcomeNudgeScheduled).to.equal(true);
    });

    it("refuses to schedule when didOptInToTrial is not true (defensive gate)", async () => {
      const userId = "posttrial-welcome-no-trial-optin";
      const userData = baseEligibleUser({ didOptInToTrial: false });
      await env.firestore.collection("users").doc(userId).set(userData);

      const firstNudgeTarget = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const service = new PosttrialNudgeService(env.firestore);

      const scheduled = await service.scheduleWelcomeIfNeeded(
        userId,
        userData,
        firstNudgeTarget,
        "en",
      );

      expect(scheduled).to.equal(false);

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(0);

      const userAfter = await env.firestore
        .collection("users")
        .doc(userId)
        .get();
      expect(userAfter.data()?.posttrialWelcomeNudgeScheduled).to.not.equal(
        true,
      );
    });

    it("uses Spanish strings for Spanish-language users", async () => {
      const userId = "posttrial-welcome-es";
      const userData = baseEligibleUser();
      await env.firestore.collection("users").doc(userId).set(userData);

      const firstNudgeTarget = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const service = new PosttrialNudgeService(env.firestore);

      const scheduled = await service.scheduleWelcomeIfNeeded(
        userId,
        userData,
        firstNudgeTarget,
        "es",
      );

      expect(scheduled).to.equal(true);

      const backlog = await env.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .get();
      expect(backlog.size).to.equal(1);

      const doc = backlog.docs[0].data();
      expect(doc.title).to.equal("Empujoncitos de actividad física extendidos");
      expect(doc.body).to.equal(
        "¡Los empujoncitos diarios para tus actividades preferidas continúan después del período de prueba! Puedes administrarlos en cualquier momento en Perfil/Configuración bajo el interruptor de empujoncitos a largo plazo.",
      );
    });
  });
});
