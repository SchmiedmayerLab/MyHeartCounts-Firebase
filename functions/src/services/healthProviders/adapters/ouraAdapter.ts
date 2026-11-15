// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHmac, timingSafeEqual } from "crypto";
import { type Response } from "express";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  getOuraClientId,
  getOuraClientSecret,
  getOuraWebhookVerificationToken,
} from "../../../env.js";
import {
  HealthProviderId,
  type ProviderTokens,
} from "../../../models/index.js";
import {
  GroveUrl,
  groveWorkoutActivity,
  MhcMeasurements,
  MhcUrl,
} from "../grove/constants.js";
import {
  isoDate,
  minutesFromSeconds as minutes,
  num,
  type ObservationDraft,
  type ObservationRecordDraft,
  quantityValue as quantity,
  type RecordingMethod,
  roundTo,
  workoutComponent,
} from "../grove/drafts.js";
import {
  civilDay,
  instant,
  offsetOfIso,
  period,
  type SourceZone,
} from "../grove/time.js";
import {
  type FetchDataParams,
  type HealthProviderAdapter,
  type ProviderFetchResult,
  type WebhookHandling,
} from "../healthProviderAdapter.js";
import {
  getJson,
  postJson,
  ProviderHttpError,
  settleEndpoint,
} from "../httpClient.js";

const AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
const REVOKE_URL = "https://api.ouraring.com/oauth/revoke";
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

/**
 * Data types subscribed to for near-real-time updates: every document type
 * this adapter fetches. A failed subscription for one type is logged and the
 * daily backfill still covers it.
 */
const SUBSCRIBED_DATA_TYPES = [
  "daily_activity",
  "sleep",
  "daily_sleep",
  "daily_spo2",
  "daily_readiness",
  "daily_cardiovascular_age",
  "vO2_max",
  "workout",
];

const SUBSCRIBED_EVENT_TYPES = ["create", "update"];

/** Safety cap on token-paginated fetches. */
const MAX_PAGES = 1000;

/** Reject Oura-signed webhooks older than this (replay protection). */
const WEBHOOK_MAX_SKEW_MS = 10 * 60 * 1000;

// --- Raw response shapes ------------------------------------------------------
// Fields are those documented for the Oura API v2 usercollection endpoints;
// everything is optional because Oura omits null-valued fields.

interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

export interface OuraDailyActivity {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  equivalent_walking_distance?: number | null;
  high_activity_time?: number | null;
  medium_activity_time?: number | null;
  low_activity_time?: number | null;
  sedentary_time?: number | null;
}

export interface OuraSleep {
  id: string;
  day: string;
  type?: string | null;
  bedtime_start?: string | null;
  bedtime_end?: string | null;
  total_sleep_duration?: number | null;
  deep_sleep_duration?: number | null;
  rem_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  awake_time?: number | null;
  time_in_bed?: number | null;
  latency?: number | null;
  efficiency?: number | null;
  lowest_heart_rate?: number | null;
  average_heart_rate?: number | null;
  average_hrv?: number | null;
  average_breath?: number | null;
}

export interface OuraDailySleep {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
}

export interface OuraDailySpo2 {
  id: string;
  day: string;
  spo2_percentage?: { average?: number | null } | null;
  breathing_disturbance_index?: number | null;
}

export interface OuraWorkout {
  id: string;
  activity?: string | null;
  calories?: number | null;
  distance?: number | null;
  intensity?: string | null;
  source?: string | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
}

export interface OuraVo2Max {
  id: string;
  day: string;
  timestamp?: string | null;
  vo2_max?: number | null;
}

export interface OuraDailyCardiovascularAge {
  id?: string;
  day: string;
  vascular_age?: number | null;
  pulse_wave_velocity?: number | null;
}

export interface OuraDailyReadiness {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
}

// --- Response validation (zod) ---------------------------------------------

const ouraTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number(),
    scope: z.string().optional(),
  })
  .passthrough();

const ouraPersonalInfoSchema = z
  .object({ id: z.string().min(1) })
  .passthrough();

const ouraListEnvelopeSchema = z
  .object({
    data: z.array(z.unknown()).optional(),
    next_token: z.string().nullish(),
  })
  .passthrough();

const ouraWebhookEventSchema = z
  .object({ user_id: z.string().min(1) })
  .passthrough();

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

export interface OuraRawData {
  activity?: OuraDailyActivity[];
  sleep?: OuraSleep[];
  dailySleep?: OuraDailySleep[];
  spo2?: OuraDailySpo2[];
  workouts?: OuraWorkout[];
  vo2Max?: OuraVo2Max[];
  cardiovascularAge?: OuraDailyCardiovascularAge[];
  readiness?: OuraDailyReadiness[];
}

/** Push a draft only when it carries a value. */
const pushIf = (
  outputs: ObservationDraft[],
  value: ObservationDraft["value"],
  draft: Omit<ObservationDraft, "value">,
): void => {
  if (value !== undefined) outputs.push({ ...draft, value });
};

const ouraWorkoutRecordingMethod = (
  source: string | null | undefined,
): RecordingMethod | undefined => {
  switch (source) {
    case "manual":
      return "manual-entry";
    case "autodetected":
      return "automatically-recorded";
    default:
      return undefined;
  }
};

export const normalizeOura = (raw: OuraRawData): ObservationRecordDraft[] => {
  const records: ObservationRecordDraft[] = [];

  // Oura daily documents carry a civil `day`; the UTC offset of that day comes
  // from the document's own `timestamp` or, failing that, any other document
  // of the same day that has one (sleep bedtimes, activity, readiness).
  const dayOffsets = new Map<string, number>();
  const learn = (day: string, iso: string | null | undefined) => {
    const offset = offsetOfIso(iso ?? undefined);
    if (offset !== undefined && !dayOffsets.has(day))
      dayOffsets.set(day, offset);
  };
  for (const item of raw.activity ?? []) learn(item.day, item.timestamp);
  for (const item of raw.readiness ?? []) learn(item.day, item.timestamp);
  for (const item of raw.dailySleep ?? []) learn(item.day, item.timestamp);
  for (const item of raw.sleep ?? []) learn(item.day, item.bedtime_end);
  const dayZone = (day: string, iso?: string | null): SourceZone => ({
    offsetMinutes: offsetOfIso(iso ?? undefined) ?? dayOffsets.get(day),
  });

  const dailyRecord = (
    sourceType: string,
    nativeRecordId: string,
    day: string,
    zone: SourceZone,
    build: (
      effective: NonNullable<ReturnType<typeof civilDay>>,
    ) => ObservationDraft[],
  ) => {
    const effective = civilDay(day, zone);
    if (effective === undefined) return;
    const outputs = build(effective);
    if (outputs.length > 0) {
      records.push({
        kind: "observations",
        sourceType,
        nativeRecordId,
        occurred: effective,
        outputs,
      });
    }
  };

  for (const activity of raw.activity ?? []) {
    dailyRecord(
      "daily_activity",
      activity.id,
      activity.day,
      dayZone(activity.day, activity.timestamp),
      (effective) => {
        const outputs: ObservationDraft[] = [];
        pushIf(outputs, quantity(activity.steps), {
          measurement: "step-count",
          effective,
        });
        pushIf(outputs, quantity(activity.active_calories), {
          measurement: "active-energy",
          effective,
        });
        pushIf(outputs, quantity(activity.equivalent_walking_distance), {
          measurement: "distance",
          effective,
        });
        pushIf(outputs, quantity(activity.score), {
          measurement: MhcMeasurements.activityScore,
          effective,
        });
        pushIf(outputs, quantity(activity.total_calories), {
          measurement: MhcMeasurements.totalEnergyBurned,
          effective,
          method: "daily-total",
        });
        pushIf(outputs, quantity(minutes(activity.high_activity_time)), {
          measurement: MhcMeasurements.highActivityDuration,
          effective,
          method: "daily-total",
        });
        pushIf(outputs, quantity(minutes(activity.medium_activity_time)), {
          measurement: MhcMeasurements.mediumActivityDuration,
          effective,
          method: "daily-total",
        });
        pushIf(outputs, quantity(minutes(activity.low_activity_time)), {
          measurement: MhcMeasurements.lowActivityDuration,
          effective,
          method: "daily-total",
        });
        pushIf(outputs, quantity(minutes(activity.sedentary_time)), {
          measurement: MhcMeasurements.sedentaryDuration,
          effective,
          method: "daily-total",
        });
        return outputs;
      },
    );
  }

  for (const sleep of raw.sleep ?? []) {
    // Every sleep output needs the exact session Period; the catalog defers
    // output when either bedtime bound is absent.
    if (!sleep.bedtime_start || !sleep.bedtime_end) continue;
    const start = Date.parse(sleep.bedtime_start);
    const end = Date.parse(sleep.bedtime_end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    const effective = period(start, end, {
      offsetMinutes: offsetOfIso(sleep.bedtime_start),
    });
    const outputs: ObservationDraft[] = [];
    const hours = num(sleep.total_sleep_duration);
    pushIf(
      outputs,
      hours === undefined ? undefined : { quantity: roundTo(hours / 3600, 4) },
      { measurement: "sleep-duration", effective },
    );
    pushIf(outputs, quantity(minutes(sleep.deep_sleep_duration)), {
      measurement: "deep-sleep-duration",
      effective,
    });
    pushIf(outputs, quantity(minutes(sleep.rem_sleep_duration)), {
      measurement: "rem-sleep-duration",
      effective,
    });
    pushIf(outputs, quantity(minutes(sleep.light_sleep_duration)), {
      measurement: "light-sleep-duration",
      effective,
    });
    pushIf(outputs, quantity(minutes(sleep.awake_time)), {
      measurement: "sleep-awake-duration",
      effective,
    });
    pushIf(outputs, quantity(sleep.lowest_heart_rate), {
      measurement: "sleep-heart-rate",
      effective,
      method: "session-minimum",
    });
    pushIf(outputs, quantity(sleep.average_heart_rate), {
      measurement: "sleep-heart-rate",
      discriminator: "session-mean",
      effective,
      method: "session-mean",
      outsideCatalog: true,
    });
    pushIf(outputs, quantity(sleep.average_breath), {
      measurement: "respiratory-rate-average",
      effective,
      method: "session-mean",
    });
    // Catalog: average_hrv is `unmodeled` (no Grove session-HRV profile).
    pushIf(outputs, quantity(sleep.average_hrv), {
      measurement: MhcMeasurements.sleepHrvRmssd,
      effective,
      method: "session-mean",
    });
    pushIf(outputs, quantity(sleep.efficiency), {
      measurement: MhcMeasurements.sleepEfficiency,
      effective,
    });
    pushIf(outputs, quantity(minutes(sleep.latency)), {
      measurement: MhcMeasurements.sleepLatency,
      effective,
    });
    pushIf(outputs, quantity(minutes(sleep.time_in_bed)), {
      measurement: MhcMeasurements.timeInBed,
      effective,
      method: "session-total",
    });
    if (sleep.type) {
      outputs.push({
        measurement: MhcMeasurements.sleepPeriodType,
        effective,
        value: {
          concept: [
            {
              system: MhcUrl.providerToken("oura", "sleep-type"),
              code: sleep.type,
            },
          ],
          text: sleep.type,
        },
      });
    }
    if (outputs.length > 0) {
      records.push({
        kind: "observations",
        sourceType: "sleep",
        nativeRecordId: sleep.id,
        occurred: effective,
        outputs,
      });
    }
  }

  for (const dailySleep of raw.dailySleep ?? []) {
    dailyRecord(
      "daily_sleep",
      dailySleep.id,
      dailySleep.day,
      dayZone(dailySleep.day, dailySleep.timestamp),
      (effective) => {
        const outputs: ObservationDraft[] = [];
        pushIf(outputs, quantity(dailySleep.score), {
          measurement: MhcMeasurements.sleepScore,
          effective,
        });
        return outputs;
      },
    );
  }

  for (const spo2 of raw.spo2 ?? []) {
    dailyRecord(
      "daily_spo2",
      spo2.id,
      spo2.day,
      dayZone(spo2.day),
      (effective) => {
        const outputs: ObservationDraft[] = [];
        pushIf(outputs, quantity(spo2.spo2_percentage?.average), {
          measurement: "oxygen-saturation-daily-average",
          effective,
        });
        pushIf(outputs, quantity(spo2.breathing_disturbance_index), {
          measurement: MhcMeasurements.breathingDisturbanceIndex,
          effective,
        });
        return outputs;
      },
    );
  }

  for (const workout of raw.workouts ?? []) {
    if (!workout.start_datetime || !workout.end_datetime) continue;
    const start = Date.parse(workout.start_datetime);
    const end = Date.parse(workout.end_datetime);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    const effective = period(start, end, {
      offsetMinutes: offsetOfIso(workout.start_datetime),
    });
    const recordingMethod = ouraWorkoutRecordingMethod(workout.source);
    const activity = groveWorkoutActivity(workout.activity ?? undefined);
    const outputs: ObservationDraft[] = [
      {
        measurement: "workout",
        effective,
        recordingMethod,
        value: {
          concept: [{ system: GroveUrl.workoutActivity, code: activity }],
          text: workout.activity ?? undefined,
        },
        components: [
          ...workoutComponent(
            "active-energy-sum",
            num(workout.calories),
            "kcal",
          ),
          ...workoutComponent("distance-sum", num(workout.distance), "m"),
        ],
      },
    ];
    if (workout.intensity) {
      outputs.push({
        measurement: MhcMeasurements.workoutIntensity,
        effective,
        recordingMethod,
        value: {
          concept: [
            {
              system: MhcUrl.providerToken("oura", "workout-intensity"),
              code: workout.intensity,
            },
          ],
          text: workout.intensity,
        },
      });
    }
    records.push({
      kind: "observations",
      sourceType: "workout",
      nativeRecordId: workout.id,
      occurred: effective,
      outputs,
    });
  }

  for (const v of raw.vo2Max ?? []) {
    // The VO2 max profile is dateTime-only; without a source timestamp there
    // is no honest instant to report, so the output is skipped.
    const value = quantity(v.vo2_max);
    if (value === undefined || !v.timestamp) continue;
    const millis = Date.parse(v.timestamp);
    if (Number.isNaN(millis)) continue;
    const effective = instant(millis, {
      offsetMinutes: offsetOfIso(v.timestamp),
    });
    records.push({
      kind: "observations",
      sourceType: "vO2_max",
      nativeRecordId: v.id,
      occurred: effective,
      outputs: [{ measurement: "vo2-max", effective, value }],
    });
  }

  for (const v of raw.cardiovascularAge ?? []) {
    // The endpoint documents no `id`; the civil day is the only stable key.
    dailyRecord(
      "daily_cardiovascular_age",
      v.id ?? v.day,
      v.day,
      dayZone(v.day),
      (effective) => {
        const outputs: ObservationDraft[] = [];
        pushIf(outputs, quantity(v.vascular_age), {
          measurement: "oura-cardiovascular-age",
          effective,
        });
        pushIf(outputs, quantity(v.pulse_wave_velocity), {
          measurement: MhcMeasurements.pulseWaveVelocity,
          effective,
        });
        return outputs;
      },
    );
  }

  for (const v of raw.readiness ?? []) {
    dailyRecord(
      "daily_readiness",
      v.id,
      v.day,
      dayZone(v.day, v.timestamp),
      (effective) => {
        const outputs: ObservationDraft[] = [];
        pushIf(outputs, quantity(v.score), {
          measurement: "oura-readiness-score",
          effective,
        });
        pushIf(outputs, quantity(v.temperature_deviation), {
          measurement: MhcMeasurements.temperatureDeviation,
          effective,
        });
        pushIf(outputs, quantity(v.temperature_trend_deviation), {
          measurement: MhcMeasurements.temperatureTrendDeviation,
          effective,
        });
        return outputs;
      },
    );
  }

  return records;
};

/** Parse an Oura webhook event POST body into a normalized notification. */
export const parseOuraEvent = (
  body: unknown,
): { providerUserId: string } | undefined => {
  const parsed = ouraWebhookEventSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return { providerUserId: parsed.data.user_id };
};

/**
 * Verify Oura's webhook signature: `x-oura-signature` is the hex HMAC-SHA256,
 * keyed with the client secret, of `x-oura-timestamp` concatenated with the
 * raw request body. Returns `undefined` when the request carries no
 * signature headers (verification cannot be performed).
 */
export const verifyOuraSignature = (params: {
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: Buffer | undefined;
  secret: string;
  now?: number;
}): boolean | undefined => {
  const { signature, timestamp, rawBody, secret } = params;
  if (!signature || !timestamp || rawBody === undefined) return undefined;
  const seconds = Number(timestamp);
  const sentAt =
    Number.isFinite(seconds) ?
      seconds > 1e12 ?
        seconds
      : seconds * 1000
    : Date.parse(timestamp);
  if (
    Number.isNaN(sentAt) ||
    Math.abs((params.now ?? Date.now()) - sentAt) > WEBHOOK_MAX_SKEW_MS
  ) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(timestamp)
    .update(rawBody)
    .digest("hex")
    .toLowerCase();
  const actual = Buffer.from(signature.toLowerCase());
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
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
    const response = ouraTokenResponseSchema.parse(
      await postJson<unknown>(
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
      ),
    );
    const providerUserId = await this.fetchProviderUserId(
      response.access_token,
    );
    return tokensFrom(response, providerUserId);
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    const response = ouraTokenResponseSchema.parse(
      await postJson<unknown>(
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
      ),
    );
    // Oura omits the user id on refresh; the service preserves the stored one.
    return tokensFrom(response, "");
  }

  async revoke(tokens: ProviderTokens): Promise<void> {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: tokens.accessToken }),
    });
    if (!response.ok) {
      throw new ProviderHttpError(
        response.status,
        await response.text(),
        "Oura revoke",
      );
    }
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

    const verified = verifyOuraSignature({
      signature: header(req, "x-oura-signature"),
      timestamp: header(req, "x-oura-timestamp"),
      rawBody: req.rawBody,
      secret: getOuraClientSecret(),
    });
    if (verified === false) {
      throw new Error("Oura webhook signature mismatch");
    }
    if (verified === undefined) {
      // Unsigned events are still accepted (the fetch window is clamped and
      // the data is pulled with our own token), but logged for monitoring.
      logger.warn("OuraAdapter: webhook event without signature headers");
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

  async fetchData(params: FetchDataParams): Promise<ProviderFetchResult> {
    const { tokens, since, until } = params;
    const token = tokens.accessToken;
    const failures: string[] = [];
    // Oura's end_date is inclusive on day documents; widen by one day at the
    // start so a sleep ending today that started yesterday is included.
    const startDate = isoDate(new Date(since.getTime() - 24 * 60 * 60 * 1000));
    const endDate = isoDate(until);
    const daily = <T>(endpoint: string) =>
      settleEndpoint(
        `Oura ${endpoint}`,
        this.fetchAll<T>(
          `${API_BASE}/${endpoint}?start_date=${startDate}&end_date=${endDate}`,
          token,
          `Oura ${endpoint}`,
        ),
        failures,
      );

    const [
      activity,
      sleep,
      dailySleep,
      spo2,
      workouts,
      vo2Max,
      cardiovascularAge,
      readiness,
      heartRate,
    ] = await Promise.all([
      daily<OuraDailyActivity>("daily_activity"),
      daily<OuraSleep>("sleep"),
      daily<OuraDailySleep>("daily_sleep"),
      daily<OuraDailySpo2>("daily_spo2"),
      daily<OuraWorkout>("workout"),
      daily<OuraVo2Max>("vO2_max"),
      daily<OuraDailyCardiovascularAge>("daily_cardiovascular_age"),
      daily<OuraDailyReadiness>("daily_readiness"),
      settleEndpoint(
        "Oura heartrate",
        this.fetchAll<unknown>(
          `${API_BASE}/heartrate?start_datetime=${encodeURIComponent(since.toISOString())}&end_datetime=${encodeURIComponent(until.toISOString())}`,
          token,
          "Oura heartrate",
        ),
        failures,
      ),
    ]);

    return {
      records: normalizeOura({
        activity,
        sleep,
        dailySleep,
        spo2,
        workouts,
        vo2Max,
        cardiovascularAge,
        readiness,
      }),
      // Continuous heart rate is an irregular high-frequency series; the
      // catalog maps it to a raw recording document (`mapped-standard`).
      rawArchives:
        heartRate !== undefined && heartRate.length > 0 ?
          [
            {
              sourceType: "heartrate",
              dataType: "heartRate",
              typeText: "Oura heart-rate samples",
              payload: heartRate,
            },
          ]
        : [],
      failures,
    };
  }

  // Helpers ------------------------------------------------------------------

  private async fetchProviderUserId(accessToken: string): Promise<string> {
    const info = ouraPersonalInfoSchema.parse(
      await getJson<unknown>(
        `${API_BASE}/personal_info`,
        accessToken,
        "Oura personal_info",
      ),
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
    while (url !== null && guard < MAX_PAGES) {
      const page = ouraListEnvelopeSchema.parse(
        await getJson<unknown>(url, token, context),
      );
      results.push(...((page.data ?? []) as T[]));
      url =
        page.next_token ?
          `${initialUrl}${initialUrl.includes("?") ? "&" : "?"}next_token=${encodeURIComponent(page.next_token)}`
        : null;
      guard++;
    }
    if (url !== null) {
      // Truncated: treat as a failure so the window is retried rather than
      // silently marking it synced.
      throw new Error(
        `${context}: reached ${MAX_PAGES}-page cap with more pages pending`,
      );
    }
    return results;
  }
}
