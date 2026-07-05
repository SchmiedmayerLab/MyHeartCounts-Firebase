// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHmac } from "crypto";
import { expect } from "chai";
import {
  normalizeFitbit,
  parseFitbitNotifications,
  verifyFitbitSignature,
} from "./fitbitAdapter.js";
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

describe("FitbitAdapter: normalizeFitbit", () => {
  it("maps steps, converts km distance to meters and reads resting HR", () => {
    const result = normalizeFitbit(
      {
        steps: [{ dateTime: "2026-01-01", value: "8000" }],
        distance: [{ dateTime: "2026-01-01", value: "5" }],
        heart: [{ dateTime: "2026-01-01", value: { restingHeartRate: 55 } }],
      },
      subject,
    );

    expect(observationFor(result, "steps").valueQuantity?.value).to.equal(8000);
    // 5 km -> 5000 m
    expect(
      observationFor(result, "distanceWalkingRunning").valueQuantity?.value,
    ).to.equal(5000);
    expect(
      observationFor(result, "restingHeartRate").valueQuantity?.value,
    ).to.equal(55);
    expect(observationFor(result, "steps").id).to.equal("fitbit-2026-01-01");
  });

  it("maps sleep stage minutes and total duration", () => {
    const result = normalizeFitbit(
      {
        sleep: [
          {
            logId: 42,
            dateOfSleep: "2026-01-01",
            startTime: "2026-01-01T23:00:00.000",
            endTime: "2026-01-02T07:00:00.000",
            minutesAsleep: 460,
            levels: {
              summary: {
                deep: { minutes: 90 },
                light: { minutes: 250 },
                rem: { minutes: 100 },
                wake: { minutes: 20 },
              },
            },
          },
        ],
      },
      subject,
    );
    expect(
      observationFor(result, "sleepDuration").valueQuantity?.value,
    ).to.equal(460);
    expect(observationFor(result, "sleepDeep").valueQuantity?.value).to.equal(
      90,
    );
    expect(observationFor(result, "sleepAwake").valueQuantity?.value).to.equal(
      20,
    );
    expect(observationFor(result, "sleepDuration").id).to.equal("fitbit-42");
  });
});

describe("FitbitAdapter: parseFitbitNotifications", () => {
  it("groups notifications per owner into a single changed window", () => {
    const result = parseFitbitNotifications([
      {
        collectionType: "activities",
        date: "2026-01-01",
        ownerId: "userA",
        ownerType: "user",
        subscriptionId: "s1",
      },
      {
        collectionType: "sleep",
        date: "2026-01-03",
        ownerId: "userA",
        ownerType: "user",
        subscriptionId: "s2",
      },
      {
        collectionType: "body",
        date: "2026-01-02",
        ownerId: "userB",
        ownerType: "user",
        subscriptionId: "s3",
      },
    ]);

    expect(result).to.have.lengthOf(2);
    const userA = result.find((n) => n.providerUserId === "userA");
    expect(userA?.since?.toISOString()).to.equal("2026-01-01T00:00:00.000Z");
    expect(userA?.until?.toISOString()).to.equal("2026-01-03T23:59:59.000Z");
  });

  it("returns an empty list for a non-array body", () => {
    expect(parseFitbitNotifications({})).to.deep.equal([]);
  });
});

describe("FitbitAdapter: verifyFitbitSignature", () => {
  const clientSecret = "shhh";
  const rawBody = Buffer.from('[{"ownerId":"userA"}]');

  it("accepts a correct HMAC-SHA1 signature (key = clientSecret + '&')", () => {
    const signature = createHmac("sha1", `${clientSecret}&`)
      .update(rawBody)
      .digest("base64");
    expect(verifyFitbitSignature(rawBody, signature, clientSecret)).to.equal(
      true,
    );
  });

  it("rejects a wrong or missing signature", () => {
    expect(verifyFitbitSignature(rawBody, "wrong", clientSecret)).to.equal(
      false,
    );
    expect(verifyFitbitSignature(rawBody, undefined, clientSecret)).to.equal(
      false,
    );
  });
});
