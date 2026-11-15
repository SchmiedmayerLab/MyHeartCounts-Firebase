// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import {
  fakeTokens,
  outputFor,
  outputsFor,
  quantityOf,
  stubFetch,
} from "./adapterTestSupport.js";
import {
  checkWithingsEnvelope,
  normalizeWithings,
  parseWithingsNotification,
  WithingsAdapter,
} from "./withingsAdapter.js";
import { ProviderAuthError } from "../httpClient.js";

const measureDate = Date.parse("2026-08-20T14:45:00Z") / 1000;

describe("WithingsAdapter: normalizeWithings", () => {
  it("applies value × 10^unit, converts height to cm, and keeps the IANA zone", () => {
    const records = normalizeWithings({
      measureTimezone: "Europe/Paris",
      measureGroups: [
        {
          grpid: 1,
          date: measureDate,
          attrib: 2,
          measures: [
            { type: 1, value: 72500, unit: -3 },
            { type: 4, value: 178, unit: -2 },
            { type: 77, value: 41, unit: 0 },
            { type: 999, value: 1, unit: 0 },
          ],
        },
      ],
    });
    const weight = outputFor(records, "body-weight");
    expect(weight.record.sourceType).to.equal("getmeas:1");
    expect(weight.record.nativeRecordId).to.equal("1");
    expect(quantityOf(weight.output)).to.equal(72.5);
    expect(weight.output.recordingMethod).to.equal("manual-entry");
    expect(weight.output.effective).to.deep.equal({
      kind: "instant",
      value: "2026-08-20T16:45:00+02:00",
      timezone: "Europe/Paris",
    });
    expect(quantityOf(outputFor(records, "body-height").output)).to.equal(178);
    expect(quantityOf(outputFor(records, "body-water-mass").output)).to.equal(
      41,
    );
    expect(records).to.have.lengthOf(3);
  });

  it("emits one blood-pressure panel only when systolic and diastolic share a group", () => {
    const records = normalizeWithings({
      measureGroups: [
        {
          grpid: 17348211,
          date: measureDate,
          timezone: "America/Los_Angeles",
          measures: [
            { type: 10, value: 118, unit: 0 },
            { type: 9, value: 76, unit: 0 },
            { type: 11, value: 64, unit: 0 },
          ],
        },
        {
          grpid: 2,
          date: measureDate,
          measures: [{ type: 10, value: 120, unit: 0 }],
        },
      ],
    });
    const panels = outputsFor(records, "blood-pressure");
    expect(panels).to.have.lengthOf(1);
    expect(panels[0].record.sourceType).to.equal("getmeas:9+10");
    expect(panels[0].record.nativeRecordId).to.equal("17348211");
    expect(
      panels[0].output.components?.map((c) => [
        c.code.code,
        "quantity" in c.value ? c.value.quantity : undefined,
      ]),
    ).to.deep.equal([
      ["8480-6", 118],
      ["8462-4", 76],
    ]);
    expect(outputFor(records, "heart-rate").record.sourceType).to.equal(
      "getmeas:11",
    );
  });

  it("emits AFib notifications only for a positive screen", () => {
    const records = normalizeWithings({
      measureGroups: [
        {
          grpid: 3,
          date: measureDate,
          measures: [
            { type: 130, value: 1, unit: 0 },
            { type: 139, value: 0, unit: 0 },
          ],
        },
      ],
    });
    expect(
      outputsFor(records, "withings-atrial-fibrillation-notification-ecg"),
    ).to.have.lengthOf(1);
    expect(
      outputsFor(records, "withings-atrial-fibrillation-notification-ppg"),
    ).to.have.lengthOf(0);
  });

  it("maps daily activity fields to separate records over the local civil day", () => {
    const records = normalizeWithings({
      activities: [
        {
          date: "2026-08-20",
          timezone: "America/New_York",
          steps: 9000,
          distance: 6500,
          calories: 410,
          totalcalories: 2300,
          intense: 1200,
        },
      ],
    });
    const steps = outputFor(records, "step-count");
    expect(steps.record.sourceType).to.equal("getactivity:steps");
    expect(steps.record.nativeRecordId).to.equal("2026-08-20");
    expect(steps.output.effective).to.deep.equal({
      kind: "period",
      start: "2026-08-20T00:00:00-04:00",
      end: "2026-08-21T00:00:00-04:00",
      timezone: "America/New_York",
    });
    expect(outputFor(records, "active-energy").record.sourceType).to.equal(
      "getactivity:calories",
    );
    expect(
      quantityOf(outputFor(records, "total-energy-burned").output),
    ).to.equal(2300);
    expect(
      quantityOf(outputFor(records, "high-activity-duration").output),
    ).to.equal(20);
  });

  it("maps sleep summary fields with conversions and methods", () => {
    const records = normalizeWithings({
      sleep: [
        {
          id: 42,
          startdate: Date.parse("2026-08-19T22:00:00Z") / 1000,
          enddate: Date.parse("2026-08-20T06:00:00Z") / 1000,
          timezone: "UTC",
          data: {
            deepsleepduration: 3600,
            remsleepduration: 5400,
            hr_average: 55,
            hr_min: 47,
            rr_average: 14,
            total_sleep_time: 25200,
            sleep_score: 80,
            sleep_efficiency: 0.92,
          },
        },
      ],
    });
    expect(
      quantityOf(outputFor(records, "deep-sleep-duration").output),
    ).to.equal(60);
    const heartRates = outputsFor(records, "sleep-heart-rate");
    expect(
      heartRates.map(({ record, output }) => [
        record.sourceType,
        output.method,
        output.outsideCatalog,
      ]),
    ).to.deep.equal([
      ["getsummary:hr_average", "session-mean", undefined],
      ["getsummary:hr_min", "session-minimum", true],
    ]);
    const total = outputFor(records, "sleep-duration");
    expect(quantityOf(total.output)).to.equal(7);
    expect(total.output.outsideCatalog).to.equal(true);
    expect(quantityOf(outputFor(records, "sleep-score").output)).to.equal(80);
    expect(quantityOf(outputFor(records, "sleep-efficiency").output)).to.equal(
      92,
    );
  });

  it("maps workouts with category and statistics", () => {
    const records = normalizeWithings({
      workouts: [
        {
          id: 7,
          category: 2,
          startdate: Date.parse("2026-08-20T07:00:00Z") / 1000,
          enddate: Date.parse("2026-08-20T07:45:00Z") / 1000,
          data: {
            calories: 400,
            distance: 7000,
            effduration: 2600,
            hr_average: 150,
          },
        },
      ],
    });
    const workout = outputFor(records, "workout");
    expect(workout.record.sourceType).to.equal("getworkouts:interval");
    expect(
      (workout.output.value as { concept: Array<{ code: string }> }).concept[0]
        .code,
    ).to.equal("running");
    expect(workout.output.components?.map((c) => c.code.code)).to.deep.equal([
      "active-duration",
      "active-energy-sum",
      "distance-sum",
      "heart-rate-avg",
    ]);
  });
});

describe("WithingsAdapter: envelopes and notifications", () => {
  it("maps auth envelope statuses to ProviderAuthError", () => {
    expect(() =>
      checkWithingsEnvelope("x", { status: 401, body: {} }),
    ).to.throw(ProviderAuthError);
    expect(() =>
      checkWithingsEnvelope("x", { status: 601, body: {} }),
    ).to.throw(Error);
    expect(() =>
      checkWithingsEnvelope("x", { status: 0, body: {} }),
    ).to.not.throw();
  });

  it("parses Notify bodies", () => {
    expect(
      parseWithingsNotification({
        userid: "12",
        startdate: "100",
        enddate: "200",
      }),
    ).to.deep.equal({
      providerUserId: "12",
      since: new Date(100_000),
      until: new Date(200_000),
    });
    expect(parseWithingsNotification({})).to.equal(undefined);
  });
});

describe("WithingsAdapter: fetchData", () => {
  it("follows more/offset pagination and archives intraday payloads", async () => {
    const getmeasOffsets: Array<string | null> = [];
    const restore = stubFetch((url, init) => {
      const body = new URLSearchParams(
        typeof init?.body === "string" ?
          init.body
        : ((init?.body as URLSearchParams | undefined)?.toString() ?? ""),
      );
      const action = body.get("action");
      if (action === "getmeas" && body.get("meastypes")?.startsWith("174")) {
        return { status: 0, body: { measuregrps: [] } };
      }
      if (action === "getmeas") {
        getmeasOffsets.push(body.get("offset"));
        return body.get("offset") === null ?
            {
              status: 0,
              body: {
                timezone: "UTC",
                more: 1,
                offset: 1,
                measuregrps: [
                  {
                    grpid: 1,
                    date: measureDate,
                    measures: [{ type: 1, value: 70, unit: 0 }],
                  },
                ],
              },
            }
          : {
              status: 0,
              body: {
                more: 0,
                measuregrps: [
                  {
                    grpid: 2,
                    date: measureDate,
                    measures: [{ type: 1, value: 71, unit: 0 }],
                  },
                ],
              },
            };
      }
      if (action === "getintradayactivity")
        return { status: 0, body: { series: {} } };
      if (action === "get") return { status: 0, body: { series: [] } };
      return { status: 0, body: {} };
    });
    try {
      const result = await new WithingsAdapter().fetchData({
        tokens: fakeTokens,
        since: new Date("2026-08-19T00:00:00Z"),
        until: new Date("2026-08-21T00:00:00Z"),
      });
      expect(getmeasOffsets).to.deep.equal([null, "1"]);
      expect(outputsFor(result.records, "body-weight")).to.have.lengthOf(2);
      expect(result.rawArchives.map((a) => a.sourceType)).to.deep.equal([
        "activityIntraday",
        "sleepIntraday",
      ]);
      expect(result.failures).to.deep.equal([]);
    } finally {
      restore();
    }
  });

  it("propagates an envelope auth failure instead of reporting success", async () => {
    const restore = stubFetch(() => ({ status: 401, body: {} }));
    try {
      let thrown: unknown;
      try {
        await new WithingsAdapter().fetchData({
          tokens: fakeTokens,
          since: new Date("2026-08-19T00:00:00Z"),
          until: new Date("2026-08-21T00:00:00Z"),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(ProviderAuthError);
    } finally {
      restore();
    }
  });
});
