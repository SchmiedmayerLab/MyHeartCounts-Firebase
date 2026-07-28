// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHmac } from "crypto";
import { expect } from "chai";
import {
  FitbitAdapter,
  normalizeFitbit,
  parseFitbitNotifications,
  verifyFitbitSignature,
} from "./fitbitAdapter.js";
import { type ProviderTokens } from "../../../models/index.js";
import { type ProviderObservation } from "../healthProviderAdapter.js";

const subject = { reference: "user/u1" };

const fakeTokens: ProviderTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: new Date(Date.now() + 3600_000),
  scopes: [],
  providerUserId: "u",
};

/**
 * Replace global fetch with a stub that maps a URL to a JSON payload (or, when
 * the value is a number, an error status). Returns a restore function.
 */
const stubFetch = (route: (url: string) => unknown): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url =
      typeof input === "string" ? input : (input as { url: string }).url;
    const payload = route(url);
    const response =
      typeof payload === "number" ?
        { ok: false, status: payload, text: () => Promise.resolve("error") }
      : {
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              payload === undefined ? "" : JSON.stringify(payload),
            ),
        };
    return Promise.resolve(response as Response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

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

  it("treats naive sleep timestamps as UTC when no offset is known", () => {
    const result = normalizeFitbit(
      {
        sleep: [
          {
            logId: 1,
            dateOfSleep: "2026-01-01",
            startTime: "2026-01-01T23:00:00.000",
            endTime: "2026-01-02T07:00:00.000",
            minutesAsleep: 480,
          },
        ],
      },
      subject,
    );
    // offset defaults to 0 -> the wall-clock value is read as UTC.
    expect(
      observationFor(
        result,
        "sleepDuration",
      ).effectivePeriod?.start?.toISOString(),
    ).to.equal("2026-01-01T23:00:00.000Z");
  });

  it("shifts naive sleep timestamps by the profile UTC offset", () => {
    // America/Los_Angeles: offsetFromUTCMillis = -8h.
    const offset = -8 * 60 * 60 * 1000;
    const result = normalizeFitbit(
      {
        sleep: [
          {
            logId: 2,
            dateOfSleep: "2026-01-01",
            startTime: "2026-01-01T23:00:00.000",
            endTime: "2026-01-02T07:00:00.000",
            minutesAsleep: 480,
          },
        ],
      },
      subject,
      offset,
    );
    // Local 23:00 PST is 07:00Z the next day.
    expect(
      observationFor(
        result,
        "sleepDuration",
      ).effectivePeriod?.start?.toISOString(),
    ).to.equal("2026-01-02T07:00:00.000Z");
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

  it("drops entries missing ownerId or date", () => {
    const result = parseFitbitNotifications([
      { ownerId: "userA", date: "2026-01-01" },
      { ownerId: "userB" },
      { date: "2026-01-02" },
      { ownerId: 5, date: "2026-01-03" },
    ]);
    expect(result).to.have.lengthOf(1);
    expect(result[0].providerUserId).to.equal("userA");
  });
});

describe("FitbitAdapter: fetchObservations", () => {
  it("applies the profile offset and tolerates a failing endpoint", async () => {
    const restore = stubFetch((url) => {
      if (url.includes("/profile.json"))
        return { user: { offsetFromUTCMillis: -8 * 60 * 60 * 1000 } };
      if (url.includes("/activities/steps/"))
        return {
          "activities-steps": [{ dateTime: "2026-01-01", value: "8000" }],
        };
      if (url.includes("/sleep/"))
        return {
          sleep: [
            {
              logId: 1,
              dateOfSleep: "2026-01-01",
              startTime: "2026-01-01T23:00:00.000",
              endTime: "2026-01-02T07:00:00.000",
              minutesAsleep: 480,
            },
          ],
        };
      if (url.includes("/br/")) return 500; // transient failure, must not throw
      return {};
    });
    try {
      const adapter = new FitbitAdapter();
      const result = await adapter.fetchObservations({
        tokens: fakeTokens,
        since: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-01-02T00:00:00Z"),
        subject,
      });
      expect(observationFor(result, "steps").valueQuantity?.value).to.equal(
        8000,
      );
      // Sleep start shifted by the -8h profile offset.
      expect(
        observationFor(
          result,
          "sleepDuration",
        ).effectivePeriod?.start?.toISOString(),
      ).to.equal("2026-01-02T07:00:00.000Z");
    } finally {
      restore();
    }
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
