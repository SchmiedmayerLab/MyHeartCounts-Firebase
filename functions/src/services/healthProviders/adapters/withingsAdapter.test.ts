// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import {
  normalizeWithings,
  parseWithingsNotification,
  WithingsAdapter,
} from "./withingsAdapter.js";
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

const stubFetch = (
  route: (url: string, body: string) => unknown,
): { restore: () => void; bodies: Map<string, string> } => {
  const original = globalThis.fetch;
  const bodies = new Map<string, string>();
  globalThis.fetch = ((
    input: unknown,
    init?: { body?: URLSearchParams | string },
  ) => {
    const url =
      typeof input === "string" ? input : (input as { url: string }).url;
    const body = init?.body?.toString() ?? "";
    bodies.set(url, body);
    const payload = route(url, body);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(payload === undefined ? "" : JSON.stringify(payload)),
    } as Response);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    bodies,
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

describe("WithingsAdapter: normalizeWithings", () => {
  it("applies the value * 10^unit scaling and maps measure types", () => {
    const result = normalizeWithings(
      {
        measureGroups: [
          {
            grpid: 100,
            date: 1735732800, // 2025-01-01T12:00:00Z
            measures: [
              { value: 705, type: 1, unit: -1 }, // weight 70.5 kg
              { value: 60, type: 11, unit: 0 }, // heart pulse 60 bpm
              { value: 981, type: 54, unit: -1 }, // spo2 98.1 %
            ],
          },
        ],
      },
      subject,
    );

    expect(observationFor(result, "bodyWeight").valueQuantity?.value).to.equal(
      70.5,
    );
    expect(observationFor(result, "heartRate").valueQuantity?.value).to.equal(
      60,
    );
    expect(
      observationFor(result, "oxygenSaturation").valueQuantity?.value,
    ).to.be.closeTo(98.1, 1e-9);
    // Document id combines group id and measure type for uniqueness.
    expect(observationFor(result, "bodyWeight").id).to.equal("withings-100-1");
  });

  it("maps sleep summary durations from seconds to minutes", () => {
    const result = normalizeWithings(
      {
        sleep: [
          {
            id: 7,
            startdate: 1735689600,
            enddate: 1735718400,
            data: {
              deepsleepduration: 5400,
              remsleepduration: 3600,
              lightsleepduration: 7200,
              wakeupduration: 600,
              hr_average: 52,
              rr_average: 13,
            },
          },
        ],
      },
      subject,
    );
    expect(observationFor(result, "sleepDeep").valueQuantity?.value).to.equal(
      90,
    );
    expect(observationFor(result, "sleepRem").valueQuantity?.value).to.equal(
      60,
    );
    expect(
      observationFor(result, "restingHeartRate").valueQuantity?.value,
    ).to.equal(52);
    expect(observationFor(result, "sleepDeep").id).to.equal("withings-7");
  });

  it("skips sleep stages that are absent instead of emitting zeros", () => {
    const result = normalizeWithings(
      {
        sleep: [
          {
            id: 8,
            startdate: 1735689600,
            enddate: 1735718400,
            data: { deepsleepduration: 5400 },
          },
        ],
      },
      subject,
    );
    const metrics = result.map((o) => o.metric);
    expect(metrics).to.include("sleepDeep");
    expect(metrics).to.not.include("sleepRem");
    expect(metrics).to.not.include("sleepLight");
    expect(metrics).to.not.include("sleepAwake");
  });

  it("ignores unmapped measure types", () => {
    const result = normalizeWithings(
      {
        measureGroups: [
          {
            grpid: 1,
            date: 1735732800,
            measures: [{ value: 5, type: 88, unit: 0 }],
          },
        ],
      },
      subject,
    );
    expect(result).to.have.lengthOf(0);
  });
});

describe("WithingsAdapter: fetchObservations", () => {
  it("calls the measure endpoints and normalizes measure groups", async () => {
    const { restore } = stubFetch((url) => {
      if (url.endsWith("/measure")) {
        return {
          status: 0,
          body: {
            measuregrps: [
              {
                grpid: 1,
                date: 1735732800,
                measures: [{ value: 705, type: 1, unit: -1 }],
              },
            ],
          },
        };
      }
      return { status: 0, body: {} };
    });
    try {
      const adapter = new WithingsAdapter();
      const result = await adapter.fetchObservations({
        tokens: fakeTokens,
        since: new Date("2026-01-01T00:00:00Z"),
        until: new Date("2026-01-02T00:00:00Z"),
        subject,
      });
      expect(
        observationFor(result, "bodyWeight").valueQuantity?.value,
      ).to.equal(70.5);
    } finally {
      restore();
    }
  });
});

describe("WithingsAdapter: removeSubscription", () => {
  it("includes the callbackurl in the revoke request", async () => {
    const { restore, bodies } = stubFetch(() => ({ status: 0, body: {} }));
    try {
      const adapter = new WithingsAdapter();
      await adapter.removeSubscription({
        tokens: fakeTokens,
        callbackUrl: "https://example.test/withingsWebhook",
      });
      const notifyBody = bodies.get("https://wbsapi.withings.net/notify");
      expect(notifyBody).to.contain("action=revoke");
      expect(notifyBody).to.contain(
        encodeURIComponent("https://example.test/withingsWebhook"),
      );
    } finally {
      restore();
    }
  });

  it("skips the revoke entirely when no callbackUrl is supplied", async () => {
    const { restore, bodies } = stubFetch(() => ({ status: 0, body: {} }));
    try {
      const adapter = new WithingsAdapter();
      await adapter.removeSubscription({ tokens: fakeTokens });
      expect(bodies.size).to.equal(0);
    } finally {
      restore();
    }
  });
});

describe("WithingsAdapter: parseWithingsNotification", () => {
  it("parses userid and the epoch window", () => {
    const result = parseWithingsNotification({
      userid: "12345",
      appli: "44",
      startdate: "1735689600",
      enddate: "1735718400",
    });
    expect(result?.providerUserId).to.equal("12345");
    expect(result?.since?.toISOString()).to.equal("2025-01-01T00:00:00.000Z");
  });

  it("accepts a numeric userid", () => {
    expect(parseWithingsNotification({ userid: 99 })?.providerUserId).to.equal(
      "99",
    );
  });

  it("returns undefined when userid is missing", () => {
    expect(parseWithingsNotification({ appli: "1" })).to.equal(undefined);
    expect(parseWithingsNotification(null)).to.equal(undefined);
  });

  it("leaves the window undefined when dates are absent or non-numeric", () => {
    const result = parseWithingsNotification({ userid: "7", appli: "44" });
    expect(result?.providerUserId).to.equal("7");
    expect(result?.since).to.equal(undefined);
    expect(result?.until).to.equal(undefined);
  });
});
