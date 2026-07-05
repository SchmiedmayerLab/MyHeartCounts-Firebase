// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { normalizeOura, parseOuraEvent } from "./ouraAdapter.js";
import { type ProviderObservation } from "../healthProviderAdapter.js";

const subject = { reference: "user/u1" };

const observationFor = (
  observations: ProviderObservation[],
  metric: string,
) => {
  const match = observations.find((o) => o.metric === metric);
  if (match === undefined)
    throw new Error(`no observation for metric ${metric}`);
  return match.observation;
};

describe("OuraAdapter: normalizeOura", () => {
  it("maps daily activity to steps, energy and distance", () => {
    const result = normalizeOura(
      {
        activity: [
          {
            id: "a1",
            day: "2026-01-01",
            steps: 1000,
            active_calories: 200,
            equivalent_walking_distance: 800,
          },
        ],
      },
      subject,
    );

    expect(result.map((o) => o.metric)).to.have.members([
      "steps",
      "activeEnergyBurned",
      "distanceWalkingRunning",
    ]);

    const steps = observationFor(result, "steps");
    expect(steps.valueQuantity?.value).to.equal(1000);
    expect(steps.id).to.equal("oura-a1");
    expect(steps.subject.reference).to.equal("user/u1");
    // Provenance extension identifies the provider and native sample id.
    const providerExt = steps.extension?.find((ext) =>
      ext.url.endsWith("/healthProvider"),
    );
    expect(providerExt?.valueString).to.equal("oura");
  });

  it("converts sleep durations from seconds to minutes and uses the sleep period", () => {
    const result = normalizeOura(
      {
        sleep: [
          {
            id: "s1",
            day: "2026-01-01",
            bedtime_start: "2026-01-01T23:00:00Z",
            bedtime_end: "2026-01-02T07:00:00Z",
            total_sleep_duration: 28800,
            deep_sleep_duration: 3600,
            lowest_heart_rate: 50,
            average_hrv: 65,
            average_breath: 14,
          },
        ],
      },
      subject,
    );

    expect(
      observationFor(result, "sleepDuration").valueQuantity?.value,
    ).to.equal(480);
    expect(observationFor(result, "sleepDeep").valueQuantity?.value).to.equal(
      60,
    );
    expect(
      observationFor(result, "restingHeartRate").valueQuantity?.value,
    ).to.equal(50);
    expect(
      observationFor(result, "heartRateVariability").valueQuantity?.value,
    ).to.equal(65);
    // Duration observations carry an effectivePeriod, not a single instant.
    const duration = observationFor(result, "sleepDuration");
    expect(duration.effectivePeriod?.start?.toISOString()).to.equal(
      "2026-01-01T23:00:00.000Z",
    );
  });

  it("computes workout duration in minutes from the interval", () => {
    const result = normalizeOura(
      {
        workouts: [
          {
            id: "w1",
            start_datetime: "2026-01-01T10:00:00Z",
            end_datetime: "2026-01-01T10:30:00Z",
          },
        ],
      },
      subject,
    );
    expect(
      observationFor(result, "workoutDuration").valueQuantity?.value,
    ).to.equal(30);
  });

  it("skips missing/undefined values", () => {
    const result = normalizeOura(
      { activity: [{ id: "a1", day: "2026-01-01" }] },
      subject,
    );
    expect(result).to.have.lengthOf(0);
  });
});

describe("OuraAdapter: parseOuraEvent", () => {
  it("extracts the provider user id", () => {
    expect(parseOuraEvent({ user_id: "abc" })).to.deep.equal({
      providerUserId: "abc",
    });
  });

  it("returns undefined for malformed events", () => {
    expect(parseOuraEvent({})).to.equal(undefined);
    expect(parseOuraEvent(null)).to.equal(undefined);
    expect(parseOuraEvent({ user_id: 5 })).to.equal(undefined);
  });
});
