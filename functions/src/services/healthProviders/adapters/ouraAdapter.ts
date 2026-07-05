// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Response } from "express";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import {
  getOuraClientId,
  getOuraClientSecret,
  getOuraWebhookVerificationToken,
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
  type WebhookHandling,
} from "../healthProviderAdapter.js";
import { getJson, postJson, ProviderHttpError } from "../httpClient.js";
import { buildProviderObservation } from "../observationBuilder.js";
import { MetricSpecs } from "../providerCodes.js";

const AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
const API_BASE = "https://api.ouraring.com/v2/usercollection";
const WEBHOOK_URL = "https://api.ouraring.com/v2/webhook/subscription";

const OURA_SCOPES = [
  "personal",
  "daily",
  "heartrate",
  "workout",
  "session",
  "spo2Daily",
];

/** Data types we subscribe to for near-real-time updates. */
const SUBSCRIBED_DATA_TYPES = [
  "daily_activity",
  "sleep",
  "daily_spo2",
  "workout",
];

const SUBSCRIBED_EVENT_TYPES = ["create", "update"];

const minutesFromSeconds = (seconds: number | null | undefined): number =>
  Math.round(((seconds ?? 0) / 60) * 100) / 100;

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

// --- Raw response shapes (only the fields we consume) ----------------------

interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

interface OuraPersonalInfo {
  id: string;
}

interface OuraList<T> {
  data?: T[];
  next_token?: string | null;
}

interface OuraHeartRatePoint {
  bpm: number;
  timestamp: string;
}

interface OuraDailyActivity {
  id: string;
  day: string;
  steps?: number;
  active_calories?: number;
  equivalent_walking_distance?: number;
  timestamp?: string;
}

interface OuraSleep {
  id: string;
  day: string;
  bedtime_start?: string;
  bedtime_end?: string;
  total_sleep_duration?: number;
  deep_sleep_duration?: number;
  rem_sleep_duration?: number;
  light_sleep_duration?: number;
  awake_time?: number;
  lowest_heart_rate?: number;
  average_hrv?: number;
  average_breath?: number;
}

interface OuraDailySpo2 {
  id: string;
  day: string;
  spo2_percentage?: { average?: number } | null;
}

interface OuraWorkout {
  id: string;
  start_datetime?: string;
  end_datetime?: string;
}

interface OuraWebhookEvent {
  event_type: string;
  data_type: string;
  object_id: string;
  event_time: string;
  user_id: string;
}

const tokensFrom = (
  response: OuraTokenResponse,
  providerUserId: string,
): ProviderTokens => ({
  accessToken: response.access_token,
  refreshToken: response.refresh_token,
  expiresAt: new Date(Date.now() + response.expires_in * 1000),
  scopes: response.scope ? response.scope.split(" ") : OURA_SCOPES,
  providerUserId,
});

// --- Pure normalization (exported for unit tests) --------------------------

const midday = (day: string): Date => new Date(`${day}T12:00:00Z`);

export const normalizeOura = (
  raw: {
    heartRate?: OuraHeartRatePoint[];
    activity?: OuraDailyActivity[];
    sleep?: OuraSleep[];
    spo2?: OuraDailySpo2[];
    workouts?: OuraWorkout[];
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
        provider: HealthProviderId.oura,
        sourceName: "Oura",
        subject,
        spec,
        value,
        effective,
        sampleId,
      }),
    );
  };

  for (const point of raw.heartRate ?? []) {
    add(
      MetricSpecs.heartRate,
      point.bpm,
      new Date(point.timestamp),
      point.timestamp,
    );
  }

  for (const activity of raw.activity ?? []) {
    add(MetricSpecs.steps, activity.steps, midday(activity.day), activity.id);
    add(
      MetricSpecs.activeEnergyBurned,
      activity.active_calories,
      midday(activity.day),
      activity.id,
    );
    add(
      MetricSpecs.distanceWalkingRunning,
      activity.equivalent_walking_distance,
      midday(activity.day),
      activity.id,
    );
  }

  for (const sleep of raw.sleep ?? []) {
    const period =
      sleep.bedtime_start && sleep.bedtime_end ?
        {
          start: new Date(sleep.bedtime_start),
          end: new Date(sleep.bedtime_end),
        }
      : midday(sleep.day);
    add(
      MetricSpecs.sleepDuration,
      minutesFromSeconds(sleep.total_sleep_duration),
      period,
      sleep.id,
    );
    add(
      MetricSpecs.sleepDeep,
      minutesFromSeconds(sleep.deep_sleep_duration),
      period,
      sleep.id,
    );
    add(
      MetricSpecs.sleepRem,
      minutesFromSeconds(sleep.rem_sleep_duration),
      period,
      sleep.id,
    );
    add(
      MetricSpecs.sleepLight,
      minutesFromSeconds(sleep.light_sleep_duration),
      period,
      sleep.id,
    );
    add(
      MetricSpecs.sleepAwake,
      minutesFromSeconds(sleep.awake_time),
      period,
      sleep.id,
    );
    add(
      MetricSpecs.restingHeartRate,
      sleep.lowest_heart_rate,
      midday(sleep.day),
      sleep.id,
    );
    add(
      MetricSpecs.heartRateVariability,
      sleep.average_hrv,
      midday(sleep.day),
      sleep.id,
    );
    add(
      MetricSpecs.respiratoryRate,
      sleep.average_breath,
      midday(sleep.day),
      sleep.id,
    );
  }

  for (const spo2 of raw.spo2 ?? []) {
    add(
      MetricSpecs.oxygenSaturation,
      spo2.spo2_percentage?.average,
      midday(spo2.day),
      spo2.id,
    );
  }

  for (const workout of raw.workouts ?? []) {
    if (!workout.start_datetime || !workout.end_datetime) continue;
    const start = new Date(workout.start_datetime);
    const end = new Date(workout.end_datetime);
    const minutes =
      Math.round(((end.getTime() - start.getTime()) / 60000) * 100) / 100;
    add(MetricSpecs.workoutDuration, minutes, { start, end }, workout.id);
  }

  return out;
};

/** Parse an Oura webhook event POST body into a normalized notification. */
export const parseOuraEvent = (
  body: unknown,
): { providerUserId: string } | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const event = body as Partial<OuraWebhookEvent>;
  if (typeof event.user_id !== "string" || event.user_id.length === 0) {
    return undefined;
  }
  return { providerUserId: event.user_id };
};

export class OuraAdapter implements HealthProviderAdapter {
  readonly id = HealthProviderId.oura;
  readonly scopes = OURA_SCOPES;
  readonly usesPkce = false;

  buildAuthorizationUrl(params: {
    state: string;
    redirectUri: string;
  }): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", getOuraClientId());
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<ProviderTokens> {
    const response = await postJson<OuraTokenResponse>(
      TOKEN_URL,
      {
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: params.code,
          redirect_uri: params.redirectUri,
          client_id: getOuraClientId(),
          client_secret: getOuraClientSecret(),
        }),
      },
      "Oura token exchange",
    );
    const providerUserId = await this.fetchProviderUserId(
      response.access_token,
    );
    return tokensFrom(response, providerUserId);
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    const response = await postJson<OuraTokenResponse>(
      TOKEN_URL,
      {
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: getOuraClientId(),
          client_secret: getOuraClientSecret(),
        }),
      },
      "Oura token refresh",
    );
    // Oura omits the user id on refresh; the service preserves the stored one.
    return tokensFrom(response, "");
  }

  async revoke(tokens: ProviderTokens): Promise<void> {
    await fetch("https://api.ouraring.com/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: tokens.accessToken }),
    });
  }

  async ensureSubscription(params: {
    callbackUrl: string;
  }): Promise<{ subscriptionId?: string }> {
    // Oura webhook subscriptions are application-scoped (authenticated with the
    // client id/secret, not the user token) and carry a user_id on every event.
    // Creating them is idempotent-by-intent: duplicates are ignored.
    for (const dataType of SUBSCRIBED_DATA_TYPES) {
      for (const eventType of SUBSCRIBED_EVENT_TYPES) {
        try {
          await postJson(
            WEBHOOK_URL,
            {
              headers: {
                "x-client-id": getOuraClientId(),
                "x-client-secret": getOuraClientSecret(),
              },
              body: JSON.stringify({
                callback_url: params.callbackUrl,
                verification_token: getOuraWebhookVerificationToken(),
                event_type: eventType,
                data_type: dataType,
              }),
            },
            "Oura subscription create",
          );
        } catch (error) {
          if (error instanceof ProviderHttpError && error.status === 409) {
            continue; // already subscribed
          }
          logger.warn(
            `OuraAdapter: subscription ${eventType}/${dataType} failed: ${String(error)}`,
          );
        }
      }
    }
    return {};
  }

  async removeSubscription(): Promise<void> {
    // App-level subscriptions are shared across users; leave them in place.
  }

  handleWebhook(req: Request, res: Response): WebhookHandling {
    // Subscription-verification handshake: Oura GETs the callback with a
    // verification_token and a challenge to echo back.
    if (req.method === "GET") {
      const token = req.query.verification_token;
      const challenge = req.query.challenge;
      if (token !== getOuraWebhookVerificationToken()) {
        throw new Error("Oura webhook verification token mismatch");
      }
      res.status(200).json({ challenge });
      return { kind: "verification" };
    }

    const parsed = parseOuraEvent(req.body);
    if (parsed === undefined) {
      return { kind: "notifications", notifications: [] };
    }
    return {
      kind: "notifications",
      notifications: [{ providerUserId: parsed.providerUserId }],
    };
  }

  async fetchObservations(
    params: FetchObservationsParams,
  ): Promise<ProviderObservation[]> {
    const { tokens, since, until, subject } = params;
    const token = tokens.accessToken;
    const startDate = isoDate(since);
    const endDate = isoDate(until);
    const startDt = since.toISOString();
    const endDt = until.toISOString();

    const [heartRate, activity, sleep, spo2, workouts] = await Promise.all([
      this.fetchAll<OuraHeartRatePoint>(
        `${API_BASE}/heartrate?start_datetime=${encodeURIComponent(startDt)}&end_datetime=${encodeURIComponent(endDt)}`,
        token,
        "Oura heartrate",
      ),
      this.fetchAll<OuraDailyActivity>(
        `${API_BASE}/daily_activity?start_date=${startDate}&end_date=${endDate}`,
        token,
        "Oura daily_activity",
      ),
      this.fetchAll<OuraSleep>(
        `${API_BASE}/sleep?start_date=${startDate}&end_date=${endDate}`,
        token,
        "Oura sleep",
      ),
      this.fetchAll<OuraDailySpo2>(
        `${API_BASE}/daily_spo2?start_date=${startDate}&end_date=${endDate}`,
        token,
        "Oura daily_spo2",
      ),
      this.fetchAll<OuraWorkout>(
        `${API_BASE}/workout?start_date=${startDate}&end_date=${endDate}`,
        token,
        "Oura workout",
      ),
    ]);

    return normalizeOura(
      { heartRate, activity, sleep, spo2, workouts },
      subject,
    );
  }

  // Helpers ------------------------------------------------------------------

  private async fetchProviderUserId(accessToken: string): Promise<string> {
    const info = await getJson<OuraPersonalInfo>(
      `${API_BASE}/personal_info`,
      accessToken,
      "Oura personal_info",
    );
    return info.id;
  }

  private async fetchAll<T>(
    initialUrl: string,
    token: string,
    context: string,
  ): Promise<T[]> {
    const results: T[] = [];
    let url: string | null = initialUrl;
    let guard = 0;
    while (url !== null && guard < 100) {
      const page: OuraList<T> = await getJson<OuraList<T>>(url, token, context);
      results.push(...(page.data ?? []));
      url =
        page.next_token ?
          `${initialUrl}${initialUrl.includes("?") ? "&" : "?"}next_token=${encodeURIComponent(page.next_token)}`
        : null;
      guard++;
    }
    return results;
  }
}
