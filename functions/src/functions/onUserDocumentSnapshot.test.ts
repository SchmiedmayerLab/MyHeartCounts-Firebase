// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import {
  type QuerySnapshot,
  type Timestamp,
  Timestamp as FirestoreTimestamp,
} from "firebase-admin/firestore";
import { it } from "mocha";
import {
  captureUserDocumentSnapshot,
  DEBOUNCE_WINDOW_MS,
  onUserDocumentSnapshot,
} from "./onUserDocumentSnapshot.js";
import {
  describeWithEmulators,
  type EmulatorTestEnvironment,
} from "../tests/functions/testEnvironment.js";

const t0 = FirestoreTimestamp.fromMillis(1_700_000_000_000);
const tPlus = (ms: number) => FirestoreTimestamp.fromMillis(t0.toMillis() + ms);
const withinWindow = tPlus(30_000);
const beyondWindow = tPlus(DEBOUNCE_WINDOW_MS + 1);

const getSnapshots = async (
  env: EmulatorTestEnvironment,
  userId: string,
): Promise<QuerySnapshot> =>
  env.collections
    .userDocumentSnapshots(userId)
    .orderBy("capturedAt", "asc")
    .get();

describeWithEmulators("function: onUserDocumentSnapshot", (env) => {
  it("creates a snapshot when demographic fields change", async () => {
    const userId = "user-demographics";

    await captureUserDocumentSnapshot(
      userId,
      {
        genderIdentity: "X",
        comorbidities: { hypertension: true },
        ghost: undefined,
      },
      null,
      t0,
    );

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(1);
    // `ghost` is stripped: undefined values never reach the snapshot.
    expect(snapshots.docs[0].get("content")).to.deep.equal({
      genderIdentity: "X",
      comorbidities: { hypertension: true },
    });
  });

  it("captures the post-write state when invoked via the trigger", async () => {
    const userId = "user-trigger-write";

    const wrapped = env.wrapTrigger(onUserDocumentSnapshot);
    await wrapped({
      params: { userId },
      data: env.createChange(`users/${userId}`, undefined, {
        genderIdentity: "X",
        fcmToken: "token-a",
      }),
    });

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(1);
    expect(snapshots.docs[0].get("content")).to.deep.equal({
      genderIdentity: "X",
    });
  });

  it("does not create a snapshot when only excluded fields change", async () => {
    const userId = "user-excluded-only";

    await captureUserDocumentSnapshot(
      userId,
      { genderIdentity: "X", fcmToken: "token-a" },
      null,
      t0,
    );
    // Only the excluded fcmToken / lastActiveDate change here.
    await captureUserDocumentSnapshot(
      userId,
      {
        genderIdentity: "X",
        fcmToken: "token-b",
        lastActiveDate: withinWindow,
      },
      null,
      withinWindow,
    );

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(1);
    // The original snapshot is untouched (its capturedAt did not advance).
    const capturedAt = snapshots.docs[0].get("capturedAt") as Timestamp;
    expect(capturedAt.toMillis()).to.equal(t0.toMillis());
  });

  it("collapses a burst of changes within the window into one snapshot", async () => {
    const userId = "user-burst";

    await captureUserDocumentSnapshot(
      userId,
      { comorbidities: { a: true } },
      null,
      t0,
    );
    await captureUserDocumentSnapshot(
      userId,
      { comorbidities: { a: true, b: true } },
      null,
      tPlus(10_000),
    );
    await captureUserDocumentSnapshot(
      userId,
      { comorbidities: { a: true, b: true, c: true } },
      null,
      tPlus(20_000),
    );

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(1);
    const doc = snapshots.docs[0];
    expect(doc.get("content")).to.deep.equal({
      comorbidities: { a: true, b: true, c: true },
    });
    // The collapsed snapshot carries the latest capture time.
    expect((doc.get("capturedAt") as Timestamp).toMillis()).to.equal(
      t0.toMillis() + 20_000,
    );
  });

  it("creates a new snapshot when a change arrives after the window", async () => {
    const userId = "user-window-elapsed";

    await captureUserDocumentSnapshot(userId, { stageOfChange: "1" }, null, t0);
    await captureUserDocumentSnapshot(
      userId,
      { stageOfChange: "2" },
      null,
      beyondWindow,
    );

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(2);
    expect(snapshots.docs[0].get("content")).to.deep.equal({
      stageOfChange: "1",
    });
    expect(snapshots.docs[1].get("content")).to.deep.equal({
      stageOfChange: "2",
    });
  });

  it("records sourceUpdatedAt when provided", async () => {
    const userId = "user-source-updated";

    await captureUserDocumentSnapshot(userId, { language: "en" }, t0, t0);

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(1);
    expect(
      (snapshots.docs[0].get("sourceUpdatedAt") as Timestamp).toMillis(),
    ).to.equal(t0.toMillis());
  });

  it("no-ops when the event carries no data", async () => {
    const userId = "user-no-event-data";

    // Invoke the handler directly: the wrapper would synthesize mock data.
    await onUserDocumentSnapshot.run({
      params: { userId },
      data: undefined,
    } as unknown as Parameters<typeof onUserDocumentSnapshot.run>[0]);

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(0);
  });

  it("does not snapshot when the user document is deleted", async () => {
    const userId = "user-deleted";

    // Seed an existing snapshot so we can assert nothing changes on deletion.
    await captureUserDocumentSnapshot(userId, { language: "en" }, null, t0);

    const wrapped = env.wrapTrigger(onUserDocumentSnapshot);
    await wrapped({
      params: { userId },
      data: env.createChange(`users/${userId}`, { language: "en" }, undefined),
    });

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(1);
    expect(
      (snapshots.docs[0].get("capturedAt") as Timestamp).toMillis(),
    ).to.equal(t0.toMillis());
  });
});
