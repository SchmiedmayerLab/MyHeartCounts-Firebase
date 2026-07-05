// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHmac, timingSafeEqual } from "crypto";
import { type Response } from "express";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import {
  getFitbitClientId,
  getFitbitClientSecret,
  getFitbitSubscriberVerificationCode,
} from "../../../env.js";
import {
  type FHIRReference,
  HealthProviderId,
  type ProviderTokens,
} from "../../../models/index.js";
import {
  type FetchObservationsParams,
  type HealthProviderAdapter,
  type ProviderObservation,
  type ProviderWebhookNotification,
  type WebhookHandling,
} from "../healthProviderAdapter.js";
import {
  basicAuthHeader,
  getJson,
  postJson,
  ProviderHttpError,
} from "../httpClient.js";
import { buildProviderObservation } from "../observationBuilder.js";
import { MetricSpecs } from "../providerCodes.js";

const AUTH_URL = "https://www.fitbit.com/oauth2/authorize";
const TOKEN_URL = "https://api.fitbit.com/oauth2/token";
const API_BASE = "https://api.fitbit.com";

const FITBIT_SCOPES = [
  "activity",
  "heartrate",
  "sleep",
  "oxygen_saturation",
  "respiratory_rate",
  "weight",
  "profile",
];

/** Fitbit subscription collections we register per connected user. */
const SUBSCRIPTION_COLLECTIONS = ["activities", "sleep", "body"];

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

// --- Raw response shapes (only the fields we consume) ----------------------

interface FitbitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  user_id: string;
}

interface FitbitDatedValue {
  dateTime: string;
  value: string;
}

interface FitbitHeartDay {
  dateTime: string;
  value: { restingHeartRate?: number };
}

interface FitbitSleep {
  logId: number;
  dateOfSleep: string;
  startTime?: string;
  endTime?: string;
  minutesAsleep?: number;
  levels?: {
    summary?: {
      deep?: { minutes?: number };
      light?: { minutes?: number };
      rem?: { minutes?: number };
      wake?: { minutes?: number };
    };
  };
}

interface FitbitSpo2Day {
  dateTime: string;
  value: { avg?: number };
}

interface FitbitBrDay {
  dateTime: string;
  value: { breathingRate?: number };
}

interface FitbitWeightLog {
  logId: number;
  date: string;
  weight?: number;
  fat?: number;
}

interface FitbitNotification {
  collectionType: string;
  date: string;
  ownerId: string;
  ownerType: string;
  subscriptionId: string;
}

const tokensFrom = (response: FitbitTokenResponse): ProviderTokens => ({
  accessToken: response.access_token,
  refreshToken: response.refresh_token,
  expiresAt: new Date(Date.now() + response.expires_in * 1000),
  scopes: response.scope ? response.scope.split(" ") : FITBIT_SCOPES,
  providerUserId: response.user_id,
});

// --- Pure normalization (exported for unit tests) --------------------------

const midday = (day: string): Date => new Date(`${day}T12:00:00Z`);

export const normalizeFitbit = (
  raw: {
    steps?: FitbitDatedValue[];
    activityCalories?: FitbitDatedValue[];
    distance?: FitbitDatedValue[];
    heart?: FitbitHeartDay[];
    sleep?: FitbitSleep[];
    spo2?: FitbitSpo2Day[];
    br?: FitbitBrDay[];
    weight?: FitbitWeightLog[];
  },
  subject: FHIRReference,
): ProviderObservation[] => {
  const out: ProviderObservation[] = [];
  const add = (
    spec: (typeof MetricSpecs)[keyof typeof MetricSpecs],
    value: number | undefined,
    effective: Date | { start: Date; end: Date },
    sampleId: string,
  ) => {
    if (value === undefined || Number.isNaN(value)) return;
    out.push(
      buildProviderObservation({
        provider: HealthProviderId.fitbit,
        sourceName: "Fitbit",
        subject,
        spec,
        value,
        effective,
        sampleId,
      }),
    );
  };

  for (const point of raw.steps ?? []) {
    add(
      MetricSpecs.steps,
      Number(point.value),
      midday(point.dateTime),
      point.dateTime,
    );
  }
  for (const point of raw.activityCalories ?? []) {
    add(
      MetricSpecs.activeEnergyBurned,
      Number(point.value),
      midday(point.dateTime),
      point.dateTime,
    );
  }
  for (const point of raw.distance ?? []) {
    // Fitbit metric distance is in km.
    add(
      MetricSpecs.distanceWalkingRunning,
      Number(point.value) * 1000,
      midday(point.dateTime),
      point.dateTime,
    );
  }
  for (const day of raw.heart ?? []) {
    add(
      MetricSpecs.restingHeartRate,
      day.value.restingHeartRate,
      midday(day.dateTime),
      day.dateTime,
    );
  }
  for (const sleep of raw.sleep ?? []) {
    const period =
      sleep.startTime && sleep.endTime ?
        { start: new Date(sleep.startTime), end: new Date(sleep.endTime) }
      : midday(sleep.dateOfSleep);
    const id = String(sleep.logId);
    add(MetricSpecs.sleepDuration, sleep.minutesAsleep, period, id);
    add(
      MetricSpecs.sleepDeep,
      sleep.levels?.summary?.deep?.minutes,
      period,
      id,
    );
    add(MetricSpecs.sleepRem, sleep.levels?.summary?.rem?.minutes, period, id);
    add(
      MetricSpecs.sleepLight,
      sleep.levels?.summary?.light?.minutes,
      period,
      id,
    );
    add(
      MetricSpecs.sleepAwake,
      sleep.levels?.summary?.wake?.minutes,
      period,
      id,
    );
  }
  for (const day of raw.spo2 ?? []) {
    add(
      MetricSpecs.oxygenSaturation,
      day.value.avg,
      midday(day.dateTime),
      day.dateTime,
    );
  }
  for (const day of raw.br ?? []) {
    add(
      MetricSpecs.respiratoryRate,
      day.value.breathingRate,
      midday(day.dateTime),
      day.dateTime,
    );
  }
  for (const log of raw.weight ?? []) {
    add(
      MetricSpecs.bodyWeight,
      log.weight,
      midday(log.date),
      String(log.logId),
    );
    add(
      MetricSpecs.bodyFatPercentage,
      log.fat,
      midday(log.date),
      `${log.logId}-fat`,
    );
  }

  return out;
};

/** Verify a Fitbit webhook body signature (HMAC-SHA1, key = clientSecret+"&"). */
export const verifyFitbitSignature = (
  rawBody: Buffer,
  signature: string | undefined,
  clientSecret: string,
): boolean => {
  if (!signature) return false;
  const expected = createHmac("sha1", `${clientSecret}&`)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Group Fitbit notifications into per-user changed windows. */
export const parseFitbitNotifications = (
  body: unknown,
): ProviderWebhookNotification[] => {
  if (!Array.isArray(body)) return [];
  const byUser = new Map<string, Set<string>>();
  for (const item of body as Array<Partial<FitbitNotification>>) {
    if (typeof item.ownerId !== "string" || typeof item.date !== "string") {
      continue;
    }
    const dates = byUser.get(item.ownerId) ?? new Set<string>();
    dates.add(item.date);
    byUser.set(item.ownerId, dates);
  }
  return Array.from(byUser.entries()).map(([providerUserId, dates]) => {
    const sorted = Array.from(dates).sort();
    const since = new Date(`${sorted[0]}T00:00:00Z`);
    const until = new Date(`${sorted[sorted.length - 1]}T23:59:59Z`);
    return { providerUserId, since, until };
  });
};

export class FitbitAdapter implements HealthProviderAdapter {
  readonly id = HealthProviderId.fitbit;
  readonly scopes = FITBIT_SCOPES;
  readonly usesPkce = true;

  buildAuthorizationUrl(params: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
  }): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", getFitbitClientId());
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", params.state);
    if (params.codeChallenge) {
      url.searchParams.set("code_challenge", params.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<ProviderTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: getFitbitClientId(),
    });
    if (params.codeVerifier) body.set("code_verifier", params.codeVerifier);
    const response = await postJson<FitbitTokenResponse>(
      TOKEN_URL,
      {
        headers: {
          Authorization: basicAuthHeader(
            getFitbitClientId(),
            getFitbitClientSecret(),
          ),
        },
        body,
      },
      "Fitbit token exchange",
    );
    return tokensFrom(response);
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    const response = await postJson<FitbitTokenResponse>(
      TOKEN_URL,
      {
        headers: {
          Authorization: basicAuthHeader(
            getFitbitClientId(),
            getFitbitClientSecret(),
          ),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      },
      "Fitbit token refresh",
    );
    return tokensFrom(response);
  }

  async revoke(tokens: ProviderTokens): Promise<void> {
    await fetch("https://api.fitbit.com/oauth2/revoke", {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(
          getFitbitClientId(),
          getFitbitClientSecret(),
        ),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: tokens.accessToken }),
    });
  }

  async ensureSubscription(params: {
    tokens: ProviderTokens;
  }): Promise<{ subscriptionId?: string }> {
    for (const collection of SUBSCRIPTION_COLLECTIONS) {
      const subscriptionId = `${params.tokens.providerUserId}-${collection}`;
      try {
        await postJson(
          `${API_BASE}/1/user/-/${collection}/apiSubscriptions/${subscriptionId}.json`,
          {
            headers: { Authorization: `Bearer ${params.tokens.accessToken}` },
            body: new URLSearchParams(),
          },
          "Fitbit subscription create",
        );
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 409) {
          continue; // already subscribed
        }
        logger.warn(
          `FitbitAdapter: subscription ${collection} failed: ${String(error)}`,
        );
      }
    }
    return { subscriptionId: params.tokens.providerUserId };
  }

  async removeSubscription(params: { tokens: ProviderTokens }): Promise<void> {
    for (const collection of SUBSCRIPTION_COLLECTIONS) {
      const subscriptionId = `${params.tokens.providerUserId}-${collection}`;
      try {
        await fetch(
          `${API_BASE}/1/user/-/${collection}/apiSubscriptions/${subscriptionId}.json`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${params.tokens.accessToken}` },
          },
        );
      } catch (error) {
        logger.warn(
          `FitbitAdapter: unsubscribe ${collection} failed: ${String(error)}`,
        );
      }
    }
  }

  handleWebhook(req: Request, res: Response): WebhookHandling {
    // One-time subscriber endpoint verification: Fitbit GETs ?verify=<code>.
    if (req.method === "GET") {
      const verify = req.query.verify;
      if (verify === getFitbitSubscriberVerificationCode()) {
        res.status(204).send();
      } else {
        res.status(404).send();
      }
      return { kind: "verification" };
    }

    const signatureValid = verifyFitbitSignature(
      req.rawBody,
      req.get("X-Fitbit-Signature") ?? undefined,
      getFitbitClientSecret(),
    );
    if (!signatureValid) {
      throw new Error("Fitbit webhook signature verification failed");
    }

    return {
      kind: "notifications",
      notifications: parseFitbitNotifications(req.body),
    };
  }

  async fetchObservations(
    params: FetchObservationsParams,
  ): Promise<ProviderObservation[]> {
    const { tokens, since, until, subject } = params;
    const token = tokens.accessToken;
    const start = isoDate(since);
    const end = isoDate(until);
    const get = <T>(path: string, context: string) =>
      getJson<T>(`${API_BASE}${path}`, token, context);

    const [
      stepsRes,
      caloriesRes,
      distanceRes,
      heartRes,
      sleepRes,
      spo2Res,
      brRes,
      weightRes,
    ] = await Promise.all([
      get<{ "activities-steps"?: FitbitDatedValue[] }>(
        `/1/user/-/activities/steps/date/${start}/${end}.json`,
        "Fitbit steps",
      ),
      get<{ "activities-activityCalories"?: FitbitDatedValue[] }>(
        `/1/user/-/activities/activityCalories/date/${start}/${end}.json`,
        "Fitbit calories",
      ),
      get<{ "activities-distance"?: FitbitDatedValue[] }>(
        `/1/user/-/activities/distance/date/${start}/${end}.json`,
        "Fitbit distance",
      ),
      get<{ "activities-heart"?: FitbitHeartDay[] }>(
        `/1/user/-/activities/heart/date/${start}/${end}.json`,
        "Fitbit heart",
      ),
      get<{ sleep?: FitbitSleep[] }>(
        `/1.2/user/-/sleep/date/${start}/${end}.json`,
        "Fitbit sleep",
      ),
      get<{ spo2?: FitbitSpo2Day[] } | FitbitSpo2Day[]>(
        `/1/user/-/spo2/date/${start}/${end}.json`,
        "Fitbit spo2",
      ),
      get<{ br?: FitbitBrDay[] }>(
        `/1/user/-/br/date/${start}/${end}.json`,
        "Fitbit br",
      ),
      get<{ weight?: FitbitWeightLog[] }>(
        `/1/user/-/body/log/weight/date/${start}/${end}.json`,
        "Fitbit weight",
      ),
    ]);

    const spo2 = Array.isArray(spo2Res) ? spo2Res : (spo2Res.spo2 ?? []);

    return normalizeFitbit(
      {
        steps: stepsRes["activities-steps"],
        activityCalories: caloriesRes["activities-activityCalories"],
        distance: distanceRes["activities-distance"],
        heart: heartRes["activities-heart"],
        sleep: sleepRes.sleep,
        spo2,
        br: brRes.br,
        weight: weightRes.weight,
      },
      subject,
    );
  }
}
