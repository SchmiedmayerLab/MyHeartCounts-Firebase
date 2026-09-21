// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { FieldPath, type Transaction } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import { DatabaseHealthStatsService } from "./healthStatsService.js";
import {
  type HealthStatsBloodPressureEntry,
  healthStatsManualEntrySourceId,
} from "../../models/index.js";
import { describeWithEmulators } from "../../tests/functions/testEnvironment.js";
import { type CollectionsService } from "../database/collections.js";
import { type DatabaseService } from "../database/databaseService.js";

const userId = "health-stats-user";
const healthKitSourceId = "com.apple.HealthKit";

const entry = (
  id: string,
  date: string,
  systolic = 120,
): HealthStatsBloodPressureEntry => ({
  id,
  date,
  systolic,
  diastolic: 80,
  unit: "mmHg",
});

describeWithEmulators("service: HealthStatsService", (env) => {
  const monthRef = () =>
    env.firestore.doc(`users/${userId}/stats/blood-pressure/months/2026-09`);
  const upsert = (entries: HealthStatsBloodPressureEntry[]) =>
    env.factory
      .healthStats()
      .upsertManualEntries(userId, "blood-pressure", "2026-09", entries);

  it("creates the month document when it does not exist", async () => {
    const first = entry("a", "2026-09-01T13:21:10+02:00");
    await upsert([first]);
    expect((await monthRef().get()).data()).to.deep.equal({
      version: 0,
      metric: "blood-pressure",
      samples: { [healthStatsManualEntrySourceId]: [first] },
    });
  });

  it("appends next to other sources without touching them", async () => {
    const healthKitEntry = entry("hk", "2026-09-01T08:00:00+02:00", 118);
    await monthRef().set({
      version: 0,
      metric: "blood-pressure",
      samples: { [healthKitSourceId]: [healthKitEntry] },
    });
    const manual = entry("a", "2026-09-02T09:00:00+02:00");
    await upsert([manual]);
    expect((await monthRef().get()).data()).to.deep.equal({
      version: 0,
      metric: "blood-pressure",
      samples: {
        [healthKitSourceId]: [healthKitEntry],
        [healthStatsManualEntrySourceId]: [manual],
      },
    });
  });

  it("replaces entries with the same id and keeps entries ordered by date", async () => {
    const later = entry("b", "2026-09-10T10:00:00+02:00");
    const earlier = entry("a", "2026-09-01T10:00:00+02:00");
    await upsert([later]);
    await upsert([earlier]);
    await upsert([{ ...later, systolic: 130 }]);
    expect(
      (await monthRef().get()).get(
        new FieldPath("samples", healthStatsManualEntrySourceId),
      ),
    ).to.deep.equal([earlier, { ...later, systolic: 130 }]);
  });

  it("leaves documents with an unsupported version untouched", async () => {
    const existing = { version: 1, metric: "blood-pressure", samples: {} };
    await monthRef().set(existing);
    await upsert([entry("a", "2026-09-01T10:00:00+02:00")]);
    expect((await monthRef().get()).data()).to.deep.equal(existing);
  });

  it("does nothing for an empty entry list", async () => {
    await upsert([]);
    expect((await monthRef().get()).exists).to.equal(false);
  });
});

const fakeDatabase = (existing?: Record<string, unknown>) => {
  const writes: Array<{ kind: string; value: unknown }> = [];
  const transaction = {
    get: () =>
      Promise.resolve({ exists: existing !== undefined, data: () => existing }),
    set: (_ref: unknown, value: unknown) => writes.push({ kind: "set", value }),
    update: (_ref: unknown, _path: unknown, value: unknown) =>
      writes.push({ kind: "update", value }),
  } as unknown as Transaction;
  const collections = {
    userHealthStatsMonth: () => ({ path: "users/u/stats/bmi/months/2026-09" }),
  } as unknown as CollectionsService;
  const databaseService = {
    runTransaction: (
      run: (
        collectionsService: CollectionsService,
        transaction: Transaction,
      ) => unknown,
    ) => Promise.resolve(run(collections, transaction)),
  } as unknown as DatabaseService;
  return { databaseService, writes };
};

describe("DatabaseHealthStatsService", () => {
  const bmiEntry = {
    id: "a",
    date: "2026-09-01T10:00:00+02:00",
    value: 25,
    unit: "count",
  };

  it("skips documents whose metric does not match", async () => {
    const { databaseService, writes } = fakeDatabase({
      version: 0,
      metric: "weight",
    });
    await new DatabaseHealthStatsService(databaseService).upsertManualEntries(
      "u",
      "bmi",
      "2026-09",
      [bmiEntry],
    );
    expect(writes).to.deep.equal([]);
  });

  it("skips documents that do not decode", async () => {
    const { databaseService, writes } = fakeDatabase({
      version: "0",
      metric: "bmi",
    });
    await new DatabaseHealthStatsService(databaseService).upsertManualEntries(
      "u",
      "bmi",
      "2026-09",
      [bmiEntry],
    );
    expect(writes).to.deep.equal([]);
  });

  it("creates the source array when the document has no samples", async () => {
    const { databaseService, writes } = fakeDatabase({
      version: 0,
      metric: "bmi",
    });
    await new DatabaseHealthStatsService(databaseService).upsertManualEntries(
      "u",
      "bmi",
      "2026-09",
      [bmiEntry],
    );
    expect(writes).to.deep.equal([{ kind: "update", value: [bmiEntry] }]);
  });

  it("keeps unrecognized entries and sorts undated entries first", async () => {
    const undecodable = { id: "x", date: "not-a-date" };
    const later = {
      id: "b",
      date: "2026-09-05T10:00:00+02:00",
      value: 1,
      unit: "count",
    };
    const { databaseService, writes } = fakeDatabase({
      version: 0,
      metric: "bmi",
      samples: {
        [healthStatsManualEntrySourceId]: ["garbage", undecodable, later],
      },
    });
    await new DatabaseHealthStatsService(databaseService).upsertManualEntries(
      "u",
      "bmi",
      "2026-09",
      [bmiEntry],
    );
    expect(writes).to.deep.equal([
      { kind: "update", value: ["garbage", undecodable, bmiEntry, later] },
    ]);
  });
});
