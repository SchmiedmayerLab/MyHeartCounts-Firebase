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
  GoogleHealthAdapter,
  normalizeGoogleHealth,
} from "./googleHealthAdapter.js";

const interval = {
  startTime: "2026-08-20T15:00:00Z",
  endTime: "2026-08-20T16:00:00Z",
  startUtcOffset: "-25200s",
};

describe("GoogleHealthAdapter: normalizeGoogleHealth", () => {
  it("parses int64-as-string values, converts units, and keeps the UTC offset", () => {
    const records = normalizeGoogleHealth({
      steps: [
        {
          name: "users/me/dataTypes/steps/dataPoints/abc",
          dataSource: { recordingMethod: "PASSIVELY_MEASURED" },
          steps: { count: "1234", interval },
        },
      ],
      distance: [{ distance: { millimeters: "1500000", interval } }],
      weight: [
        {
          weight: {
            weightGrams: 72500,
            sampleTime: { physicalTime: "2026-08-20T15:00:00Z" },
          },
        },
      ],
      height: [
        {
          height: {
            heightMillimeters: "1780",
            sampleTime: { physicalTime: "2026-08-20T15:00:00Z" },
          },
        },
      ],
    });
    const steps = outputFor(records, "step-count");
    expect(steps.record.nativeRecordId).to.equal("abc");
    expect(quantityOf(steps.output)).to.equal(1234);
    expect(steps.output.recordingMethod).to.equal("automatically-recorded");
    expect(steps.output.effective).to.deep.include({
      start: "2026-08-20T08:00:00-07:00",
      end: "2026-08-20T09:00:00-07:00",
    });
    expect(quantityOf(outputFor(records, "distance").output)).to.equal(1500);
    expect(quantityOf(outputFor(records, "body-weight").output)).to.equal(72.5);
    expect(quantityOf(outputFor(records, "body-height").output)).to.equal(178);
  });

  it("maps RMSSD and SDNN to separate Grove HRV profiles of one record", () => {
    const records = normalizeGoogleHealth({
      heartRateVariability: [
        {
          heartRateVariability: {
            rootMeanSquareOfSuccessiveDifferencesMilliseconds: 42,
            standardDeviationMilliseconds: 55,
            sampleTime: { physicalTime: "2026-08-20T05:00:00Z" },
          },
        },
      ],
    });
    expect(records).to.have.lengthOf(1);
    expect(
      quantityOf(outputFor(records, "heart-rate-variability-rmssd").output),
    ).to.equal(42);
    expect(
      quantityOf(outputFor(records, "heart-rate-variability-sdnn").output),
    ).to.equal(55);
  });

  it("maps daily summaries to a full civil-day Period with daily-mean methods", () => {
    const records = normalizeGoogleHealth({
      dailyRestingHeartRate: [
        {
          dailyRestingHeartRate: {
            beatsPerMinute: "58",
            date: { year: 2026, month: 8, day: 20 },
          },
        },
      ],
      dailyRespiratoryRate: [
        {
          dailyRespiratoryRate: {
            breathsPerMinute: 14.2,
            date: { year: 2026, month: 8, day: 20 },
          },
        },
      ],
      dailyOxygenSaturation: [
        {
          dailyOxygenSaturation: {
            averagePercentage: 96.5,
            lowerBoundPercentage: 93,
            upperBoundPercentage: 99,
            date: { year: 2026, month: 8, day: 20 },
          },
        },
      ],
    });
    const resting = outputFor(
      records,
      "resting-heart-rate-daily-average",
    ).output;
    expect(resting.effective).to.deep.include({
      start: "2026-08-20T00:00:00Z",
      end: "2026-08-21T00:00:00Z",
    });
    expect(
      outputFor(records, "respiratory-rate-average").output.method,
    ).to.equal("daily-mean");
    expect(
      quantityOf(
        outputFor(records, "oxygen-saturation-daily-lower-bound").output,
      ),
    ).to.equal(93);
    expect(
      quantityOf(
        outputFor(records, "oxygen-saturation-daily-upper-bound").output,
      ),
    ).to.equal(99);
  });

  it("maps sleep totals, stage intervals and links stages via hasMember", () => {
    const records = normalizeGoogleHealth({
      sleep: [
        {
          name: "users/me/dataTypes/sleep/dataPoints/s1",
          sleep: {
            interval: {
              startTime: "2026-08-20T05:00:00Z",
              endTime: "2026-08-20T13:00:00Z",
            },
            summary: {
              minutesAsleep: "450",
              stagesSummary: [
                { type: "DEEP", minutes: "60" },
                { type: "REM", minutes: "90" },
              ],
            },
            stages: [
              {
                type: "LIGHT",
                startTime: "2026-08-20T05:00:00Z",
                endTime: "2026-08-20T06:00:00Z",
              },
              {
                type: "DEEP",
                startTime: "2026-08-20T06:00:00Z",
                endTime: "2026-08-20T07:00:00Z",
              },
            ],
          },
        },
      ],
    });
    expect(records).to.have.lengthOf(1);
    const duration = outputFor(records, "sleep-duration").output;
    expect(quantityOf(duration)).to.equal(7.5);
    expect(duration.hasMember).to.have.lengthOf(2);
    expect(
      quantityOf(outputFor(records, "deep-sleep-duration").output),
    ).to.equal(60);
    expect(outputsFor(records, "light-sleep-duration")).to.have.lengthOf(0);
    const stages = outputsFor(records, "sleep-stage");
    expect(stages).to.have.lengthOf(2);
    expect(stages[0].output.outsideCatalog).to.equal(true);
  });

  it("maps exercise type and metrics summary", () => {
    const records = normalizeGoogleHealth({
      exercise: [
        {
          exercise: {
            interval: {
              startTime: "2026-08-20T07:00:00Z",
              endTime: "2026-08-20T07:30:00Z",
            },
            exerciseType: "RUNNING",
            activeDuration: "1700s",
            metricsSummary: {
              caloriesKcal: 300,
              distanceMillimeters: "5000000",
            },
          },
        },
      ],
    });
    const workout = outputFor(records, "workout").output;
    expect(
      (workout.value as { concept: Array<{ code: string }> }).concept.map(
        (c) => c.code,
      ),
    ).to.deep.equal(["running", "RUNNING"]);
    expect(workout.components?.map((c) => c.code.code)).to.deep.equal([
      "active-duration",
      "active-energy-sum",
      "distance-sum",
    ]);
  });
});

describe("GoogleHealthAdapter: fetchData", () => {
  it("reconciles each data type, follows pagination, and records failing endpoints", async () => {
    let stepPages = 0;
    const restore = stubFetch((url) => {
      if (url.includes("/dataTypes/steps/")) {
        stepPages += 1;
        return url.includes("pageToken") ?
            { dataPoints: [{ steps: { count: "2", interval } }] }
          : {
              dataPoints: [
                {
                  steps: {
                    count: "1",
                    interval: {
                      ...interval,
                      startTime: "2026-08-20T14:00:00Z",
                    },
                  },
                },
              ],
              nextPageToken: "p2",
            };
      }
      if (url.includes("/dataTypes/weight/")) return { __status: 500 };
      if (url.includes("/dataTypes/heart-rate/dataPoints?")) {
        return { dataPoints: [{ heartRate: { beatsPerMinute: "60" } }] };
      }
      return { dataPoints: [] };
    });
    try {
      const result = await new GoogleHealthAdapter().fetchData({
        tokens: fakeTokens,
        since: new Date("2026-08-20T00:00:00Z"),
        until: new Date("2026-08-21T00:00:00Z"),
      });
      expect(stepPages).to.equal(2);
      expect(outputsFor(result.records, "step-count")).to.have.lengthOf(2);
      expect(result.failures).to.deep.equal(["GoogleHealth weight"]);
      expect(result.rawArchives).to.have.lengthOf(1);
      expect(result.rawArchives[0].sourceType).to.equal("heart-rate");
    } finally {
      restore();
    }
  });
});
