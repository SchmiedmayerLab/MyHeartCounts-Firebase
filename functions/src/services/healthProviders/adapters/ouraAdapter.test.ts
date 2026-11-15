// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHmac } from "crypto";
import { expect } from "chai";
import {
  fakeTokens,
  outputFor,
  outputsFor,
  quantityOf,
  stubFetch,
} from "./adapterTestSupport.js";
import {
  normalizeOura,
  OuraAdapter,
  parseOuraEvent,
  verifyOuraSignature,
} from "./ouraAdapter.js";

describe("OuraAdapter: normalizeOura", () => {
  it("maps daily activity to a civil-day Period with the source offset", () => {
    const records = normalizeOura({
      activity: [
        {
          id: "a1",
          day: "2026-08-20",
          timestamp: "2026-08-20T04:00:00-07:00",
          steps: 8241,
          active_calories: 420,
          equivalent_walking_distance: 6100,
          total_calories: 2400,
          score: 82,
          high_activity_time: 600,
        },
      ],
    });
    expect(records).to.have.lengthOf(1);
    expect(records[0].sourceType).to.equal("daily_activity");
    expect(records[0].nativeRecordId).to.equal("a1");
    const steps = outputFor(records, "step-count").output;
    expect(steps.effective).to.deep.equal({
      kind: "period",
      start: "2026-08-20T00:00:00-07:00",
      end: "2026-08-21T00:00:00-07:00",
      timezone: undefined,
    });
    expect(quantityOf(steps)).to.equal(8241);
    expect(quantityOf(outputFor(records, "active-energy").output)).to.equal(
      420,
    );
    expect(quantityOf(outputFor(records, "distance").output)).to.equal(6100);
    expect(
      quantityOf(outputFor(records, "total-energy-burned").output),
    ).to.equal(2400);
    expect(quantityOf(outputFor(records, "activity-score").output)).to.equal(
      82,
    );
    expect(
      quantityOf(outputFor(records, "high-activity-duration").output),
    ).to.equal(10);
  });

  it("maps a sleep session to Grove sleep profiles over the bedtime Period", () => {
    const records = normalizeOura({
      sleep: [
        {
          id: "s1",
          day: "2026-08-20",
          type: "long_sleep",
          bedtime_start: "2026-08-19T23:00:00+02:00",
          bedtime_end: "2026-08-20T07:00:00+02:00",
          total_sleep_duration: 25200,
          deep_sleep_duration: 3600,
          rem_sleep_duration: 5400,
          light_sleep_duration: 16200,
          awake_time: 1800,
          lowest_heart_rate: 48,
          average_heart_rate: 55,
          average_hrv: 41,
          average_breath: 14.5,
          efficiency: 90,
          latency: 600,
        },
      ],
    });
    expect(records).to.have.lengthOf(1);
    const duration = outputFor(records, "sleep-duration").output;
    expect(quantityOf(duration)).to.equal(7);
    expect(duration.effective).to.deep.include({
      start: "2026-08-19T23:00:00+02:00",
      end: "2026-08-20T07:00:00+02:00",
    });
    expect(
      quantityOf(outputFor(records, "deep-sleep-duration").output),
    ).to.equal(60);
    const heartRates = outputsFor(records, "sleep-heart-rate");
    expect(heartRates.map(({ output }) => output.method)).to.deep.equal([
      "session-minimum",
      "session-mean",
    ]);
    expect(heartRates[1].output.outsideCatalog).to.equal(true);
    expect(heartRates[1].output.discriminator).to.equal("session-mean");
    expect(
      outputFor(records, "respiratory-rate-average").output.method,
    ).to.equal("session-mean");
    expect(
      quantityOf(
        outputFor(records, "sleep-heart-rate-variability-rmssd").output,
      ),
    ).to.equal(41);
    expect(quantityOf(outputFor(records, "sleep-latency").output)).to.equal(10);
    expect(
      outputFor(records, "sleep-period-type").output.value,
    ).to.deep.include({
      text: "long_sleep",
    });
  });

  it("defers sleep output when a bedtime bound is missing", () => {
    expect(
      normalizeOura({
        sleep: [{ id: "s1", day: "2026-08-20", total_sleep_duration: 100 }],
      }),
    ).to.have.lengthOf(0);
  });

  it("borrows the day's offset for documents without a timestamp", () => {
    const records = normalizeOura({
      activity: [
        { id: "a1", day: "2026-08-20", timestamp: "2026-08-20T04:00:00+09:00" },
      ],
      spo2: [
        {
          id: "o1",
          day: "2026-08-20",
          spo2_percentage: { average: 97.2 },
          breathing_disturbance_index: 3,
        },
      ],
    });
    const spo2 = outputFor(records, "oxygen-saturation-daily-average").output;
    expect(spo2.effective).to.deep.include({
      start: "2026-08-20T00:00:00+09:00",
    });
    expect(
      quantityOf(outputFor(records, "breathing-disturbance-index").output),
    ).to.equal(3);
  });

  it("maps workouts to the Grove workout profile with activity and statistics", () => {
    const records = normalizeOura({
      workouts: [
        {
          id: "w1",
          activity: "running",
          calories: 300,
          distance: 5000,
          intensity: "hard",
          source: "manual",
          start_datetime: "2026-08-20T07:00:00-04:00",
          end_datetime: "2026-08-20T07:30:00-04:00",
        },
      ],
    });
    const workout = outputFor(records, "workout").output;
    expect(workout.value).to.deep.equal({
      concept: [
        {
          system:
            "https://grovealliance.org/fhir/mobile/CodeSystem/grove-workout-activity",
          code: "running",
        },
      ],
      text: "running",
    });
    expect(workout.recordingMethod).to.equal("manual-entry");
    expect(workout.components?.map((c) => c.code.code)).to.deep.equal([
      "active-energy-sum",
      "distance-sum",
    ]);
    expect(
      outputFor(records, "workout-intensity").output.value,
    ).to.deep.include({ text: "hard" });
  });

  it("maps VO2 max at its timestamp and skips it without one", () => {
    const records = normalizeOura({
      vo2Max: [
        {
          id: "v1",
          day: "2026-08-20",
          timestamp: "2026-08-20T08:00:00+01:00",
          vo2_max: 44,
        },
        { id: "v2", day: "2026-08-21", vo2_max: 45 },
      ],
    });
    expect(records).to.have.lengthOf(1);
    expect(outputFor(records, "vo2-max").output.effective).to.deep.include({
      kind: "instant",
      value: "2026-08-20T08:00:00+01:00",
    });
  });

  it("maps readiness, temperature deviation and cardiovascular age, skipping nulls", () => {
    const records = normalizeOura({
      readiness: [
        {
          id: "r1",
          day: "2026-08-20",
          score: 78,
          temperature_deviation: -0.2,
          temperature_trend_deviation: null,
        },
        { id: "r2", day: "2026-08-21", score: null },
      ],
      cardiovascularAge: [
        { day: "2026-08-20", vascular_age: 35, pulse_wave_velocity: 6.1 },
      ],
    });
    expect(
      quantityOf(outputFor(records, "oura-readiness-score").output),
    ).to.equal(78);
    expect(
      quantityOf(outputFor(records, "temperature-deviation").output),
    ).to.equal(-0.2);
    expect(outputsFor(records, "temperature-trend-deviation")).to.have.lengthOf(
      0,
    );
    const age = outputFor(records, "oura-cardiovascular-age");
    expect(age.record.nativeRecordId).to.equal("2026-08-20");
    expect(quantityOf(age.output)).to.equal(35);
    expect(
      quantityOf(outputFor(records, "pulse-wave-velocity").output),
    ).to.equal(6.1);
  });
});

describe("OuraAdapter: fetchData", () => {
  it("follows next_token pagination, archives heart rate, and reports failures", async () => {
    let activityCalls = 0;
    const restore = stubFetch((url) => {
      if (url.includes("/daily_activity")) {
        activityCalls += 1;
        return url.includes("next_token") ?
            {
              data: [{ id: "a2", day: "2026-01-02", steps: 500 }],
              next_token: null,
            }
          : {
              data: [{ id: "a1", day: "2026-01-01", steps: 1000 }],
              next_token: "page2",
            };
      }
      if (url.includes("/heartrate")) {
        return {
          data: [{ bpm: 60, timestamp: "2026-01-01T00:00:00Z" }],
          next_token: null,
        };
      }
      if (url.includes("/daily_readiness")) return { __status: 503 };
      return { data: [] };
    });
    try {
      const result = await new OuraAdapter().fetchData({
        tokens: fakeTokens,
        since: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-01-02T00:00:00Z"),
      });
      expect(activityCalls).to.equal(2);
      expect(outputsFor(result.records, "step-count")).to.have.lengthOf(2);
      expect(result.rawArchives).to.have.lengthOf(1);
      expect(result.rawArchives[0]).to.include({
        sourceType: "heartrate",
        dataType: "heartRate",
      });
      expect(result.failures).to.deep.equal(["Oura daily_readiness"]);
    } finally {
      restore();
    }
  });

  it("propagates auth failures", async () => {
    const restore = stubFetch(() => ({ __status: 401 }));
    try {
      let thrown: unknown;
      try {
        await new OuraAdapter().fetchData({
          tokens: fakeTokens,
          since: new Date("2026-01-01T00:00:00Z"),
          until: new Date("2026-01-02T00:00:00Z"),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(Error);
    } finally {
      restore();
    }
  });
});

describe("OuraAdapter: webhooks", () => {
  it("extracts the provider user id", () => {
    expect(parseOuraEvent({ user_id: "abc" })).to.deep.equal({
      providerUserId: "abc",
    });
    expect(parseOuraEvent({})).to.equal(undefined);
    expect(parseOuraEvent({ user_id: 5 })).to.equal(undefined);
  });

  it("verifies the HMAC signature over timestamp + raw body", () => {
    const rawBody = Buffer.from('{"user_id":"abc"}');
    const now = Date.parse("2026-08-20T00:00:00Z");
    const timestamp = String(Math.floor(now / 1000));
    const signature = createHmac("sha256", "secret")
      .update(timestamp)
      .update(rawBody)
      .digest("hex")
      .toUpperCase();
    expect(
      verifyOuraSignature({
        signature,
        timestamp,
        rawBody,
        secret: "secret",
        now,
      }),
    ).to.equal(true);
    expect(
      verifyOuraSignature({
        signature,
        timestamp,
        rawBody,
        secret: "other",
        now,
      }),
    ).to.equal(false);
    expect(
      verifyOuraSignature({
        signature,
        timestamp,
        rawBody,
        secret: "secret",
        now: now + 3600_000,
      }),
    ).to.equal(false);
    expect(
      verifyOuraSignature({
        signature: undefined,
        timestamp,
        rawBody,
        secret: "secret",
        now,
      }),
    ).to.equal(undefined);
  });
});
