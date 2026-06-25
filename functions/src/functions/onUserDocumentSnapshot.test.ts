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
import firebaseFunctionsTest from "firebase-functions-test";
import { it } from "mocha";
import {
  captureUserDocumentSnapshot,
  DEBOUNCE_WINDOW_MS,
  onUserDocumentSnapshot,
  USER_DOCUMENT_SNAPSHOTS_COLLECTION,
} from "./onUserDocumentSnapshot.js";
import {
  describeWithEmulators,
  type EmulatorTestEnvironment,
} from "../tests/functions/testEnvironment.js";

const t0 = FirestoreTimestamp.fromMillis(1_700_000_000_000);
const withinWindow = FirestoreTimestamp.fromMillis(t0.toMillis() + 30_000);
const beyondWindow = FirestoreTimestamp.fromMillis(
  t0.toMillis() + DEBOUNCE_WINDOW_MS + 1,
);

const getSnapshots = async (
  env: EmulatorTestEnvironment,
  userId: string,
): Promise<QuerySnapshot> =>
  env.firestore
    .collection("users")
    .doc(userId)
    .collection(USER_DOCUMENT_SNAPSHOTS_COLLECTION)
    .orderBy("capturedAt", "asc")
    .get();

describeWithEmulators("function: onUserDocumentSnapshot", (env) => {
  it("creates a snapshot when demographic fields change", async () => {
    const userId = "user-demographics";

    await captureUserDocumentSnapshot(
      userId,
      { genderIdentity: "X", comorbidities: { hypertension: true } },
      null,
      t0,
    );

    const snapshots = await getSnapshots(env, userId);
    expect(snapshots.size).to.equal(1);
    const content = snapshots.docs[0].get("content") as Record<string, unknown>;
    expect(content.genderIdentity).to.equal("X");
    expect(content.comorbidities).to.deep.equal({ hypertension: true });
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
      FirestoreTimestamp.fromMillis(t0.toMillis() + 10_000),
    );
    await captureUserDocumentSnapshot(
      userId,
      { comorbidities: { a: true, b: true, c: true } },
      null,
      FirestoreTimestamp.fromMillis(t0.toMillis() + 20_000),
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

  it("does not snapshot when the user document is deleted", async () => {
    const userId = "user-deleted";

    // Seed an existing snapshot so we can assert nothing changes on deletion.
    await captureUserDocumentSnapshot(userId, { language: "en" }, null, t0);

    const wrapped = firebaseFunctionsTest().wrap(onUserDocumentSnapshot);
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
