// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Response } from "express";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import { z } from "zod";
import { getWithingsClientId, getWithingsClientSecret } from "../../../env.js";
import {
  HealthProviderId,
  type ProviderTokens,
} from "../../../models/index.js";
import {
  type AggregationMethod,
  GroveUrl,
  groveWorkoutActivity,
  type MhcMeasurement,
  MhcMeasurements,
  MhcUrl,
} from "../grove/constants.js";
import {
  isoDate as ymd,
  minutesFromSeconds as minutes,
  num,
  type ObservationDraft,
  type ObservationRecordDraft,
  type RecordingMethod,
  round,
  roundTo,
  workoutComponent,
} from "../grove/drafts.js";
import { civilDay, instant, period, type SourceZone } from "../grove/time.js";
import {
  type FetchDataParams,
  type HealthProviderAdapter,
  type ProviderFetchResult,
  type ProviderRawArchive,
  type WebhookHandling,
} from "../healthProviderAdapter.js";
import { postJson, ProviderAuthError, settleEndpoint } from "../httpClient.js";

const AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
const OAUTH_URL = "https://wbsapi.withings.net/v2/oauth2";
const MEASURE_URL = "https://wbsapi.withings.net/measure";
const V2_MEASURE_URL = "https://wbsapi.withings.net/v2/measure";
const V2_SLEEP_URL = "https://wbsapi.withings.net/v2/sleep";
const NOTIFY_URL = "https://wbsapi.withings.net/notify";

const WITHINGS_SCOPES = ["user.metrics", "user.activity", "user.info"];

/**
 * Withings Notify `appli` categories: 1 weight/body composition, 4 blood
 * pressure/heart rate/SpO2/temperature, 16 activity, 44 sleep, 54 ECG.
 */
const NOTIFY_APPLI = [1, 4, 16, 44, 54];

/** Withings envelope statuses that mean the access token is unusable. */
const AUTH_FAILURE_STATUSES = new Set([100, 101, 102, 200, 401]);

/** Safety cap on `more`/`offset` pagination. */
const MAX_PAGES = 200;

/**
 * Withings `getmeas` measure types with a Grove profile (catalog rows
 * `getmeas:N`). Values are `value × 10^unit` in the unit the catalog names;
 * height arrives in metres and is converted to the profile's centimetres.
 * Types 9 and 10 are only emitted together as one blood-pressure panel.
 */
const MEASURE_TYPES: Partial<
  Record<number, { measurement: string; scale?: number }>
> = {
  1: { measurement: "body-weight" },
  4: { measurement: "body-height", scale: 100 },
  5: { measurement: "lean-body-mass" },
  6: { measurement: "body-fat-percentage" },
  8: { measurement: "body-fat-mass" },
  11: { measurement: "heart-rate" },
  54: { measurement: "oxygen-saturation" },
  71: { measurement: "body-temperature" },
  73: { measurement: "skin-temperature" },
  76: { measurement: "muscle-mass" },
  77: { measurement: "body-water-mass" },
  88: { measurement: "bone-mass" },
  91: { measurement: "withings-pulse-wave-velocity" },
  123: { measurement: "vo2-max" },
  135: { measurement: "qrs-duration" },
  136: { measurement: "pr-interval" },
  137: { measurement: "qt-interval" },
  138: { measurement: "corrected-qt-interval" },
  155: { measurement: "withings-vascular-age" },
  167: { measurement: "withings-nerve-health-score" },
  168: { measurement: "extracellular-water-mass" },
  169: { measurement: "intracellular-water-mass" },
  170: { measurement: "withings-visceral-fat-index" },
  196: { measurement: "electrodermal-activity" },
};

/** AFib screening results; only a positive result (`1`) is emitted. */
const AFIB_TYPES: Partial<Record<number, string>> = {
  130: "withings-atrial-fibrillation-notification-ecg",
  139: "withings-atrial-fibrillation-notification-ppg",
};

/** Catalog `intentionally-unsupported` types, kept only as a raw archive. */
const RAW_ONLY_MEASURE_TYPES = [174, 175];

const ALL_MEASURE_TYPES = [
  ...Object.keys(MEASURE_TYPES).map(Number),
  ...Object.keys(AFIB_TYPES).map(Number),
  9,
  10,
];

/** Withings workout `category` → Grove workout activity. */
const WORKOUT_CATEGORIES: Partial<Record<number, string>> = {
  1: "walking",
  2: "running",
  3: "hiking",
  6: "cycling",
  7: "swimming",
  12: "tennis",
  13: "table-tennis",
  14: "squash",
  15: "badminton",
  16: "strength-training",
  18: "elliptical",
  19: "pilates",
  20: "basketball",
  21: "soccer",
  22: "american-football",
  24: "volleyball",
  27: "golf",
  28: "yoga",
  29: "dancing",
  30: "boxing",
  33: "martial-arts",
  34: "skiing",
  35: "snowboarding",
  187: "rowing",
  188: "dancing",
  191: "baseball",
  306: "walking",
  307: "running",
  308: "cycling",
};

const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

// --- Raw response shapes ------------------------------------------------------

interface WithingsEnvelope<T> {
  status: number;
  body: T;
  error?: string;
}

interface WithingsTokenBody {
  userid: number | string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

export interface WithingsMeasure {
  value: number;
  type: number;
  unit: number;
}
export interface WithingsMeasureGroup {
  grpid: number;
  date: number;
  attrib?: number;
  category?: number;
  timezone?: string;
  measures: WithingsMeasure[];
}
export interface WithingsActivity {
  date: string;
  timezone?: string;
  steps?: number;
  distance?: number;
  calories?: number;
  totalcalories?: number;
  elevation?: number;
  soft?: number;
  moderate?: number;
  intense?: number;
  active?: number;
}
export interface WithingsSleepSummary {
  id: number;
  startdate: number;
  enddate: number;
  date?: string;
  timezone?: string;
  data?: Record<string, number | undefined>;
}
export interface WithingsWorkout {
  id: number;
  category?: number;
  timezone?: string;
  attrib?: number;
  startdate: number;
  enddate: number;
  data?: Record<string, number | undefined>;
}

// --- Validation (zod) ----------------------------------------------------------

const withingsTokenBodySchema = z
  .object({
    userid: z.union([z.number(), z.string()]),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number(),
    scope: z.string().optional(),
  })
  .passthrough();

const withingsNotificationSchema = z
  .object({
    userid: z.union([z.string(), z.number()]),
    startdate: z.union([z.string(), z.number()]).optional(),
    enddate: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const tokensFrom = (body: WithingsTokenBody): ProviderTokens => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token,
  expiresAt: new Date(Date.now() + body.expires_in * 1000),
  scopes: body.scope ? body.scope.split(",") : WITHINGS_SCOPES,
  providerUserId: String(body.userid),
});

// --- Pure normalization (exported for unit tests) --------------------------

export interface WithingsRawData {
  measureGroups?: WithingsMeasureGroup[];
  /** Top-level `timezone` of the getmeas body. */
  measureTimezone?: string;
  activities?: WithingsActivity[];
  sleep?: WithingsSleepSummary[];
  workouts?: WithingsWorkout[];
}

/** Withings `attrib` 2 and 4 are user-entered values. */
const recordingMethodOf = (
  attrib: number | undefined,
): RecordingMethod | undefined =>
  attrib === 2 || attrib === 4 ? "manual-entry" : undefined;

const single = (
  sourceType: string,
  nativeRecordId: string,
  output: ObservationDraft,
): ObservationRecordDraft => ({
  kind: "observations",
  sourceType,
  nativeRecordId,
  occurred: output.effective,
  outputs: [output],
});

/** One `getsummary` / `getactivity` field, catalog (Grove id) or MHC extra. */
interface FieldMapping {
  field: string;
  measurement: string | MhcMeasurement;
  convert?: (value: number) => number | undefined;
  method?: AggregationMethod;
  discriminator?: string;
  outsideCatalog?: boolean;
}

const SLEEP_FIELDS: FieldMapping[] = [
  {
    field: "deepsleepduration",
    measurement: "deep-sleep-duration",
    convert: minutes,
  },
  {
    field: "remsleepduration",
    measurement: "rem-sleep-duration",
    convert: minutes,
  },
  {
    field: "lightsleepduration",
    measurement: "light-sleep-duration",
    convert: minutes,
  },
  {
    field: "wakeupduration",
    measurement: "sleep-awake-duration",
    convert: minutes,
  },
  {
    field: "hr_average",
    measurement: "sleep-heart-rate",
    method: "session-mean",
  },
  {
    field: "rr_average",
    measurement: "respiratory-rate-average",
    method: "session-mean",
  },
  // Out-of-catalog fields (Grove measurement where one fits, else MHC).
  {
    field: "total_sleep_time",
    measurement: "sleep-duration",
    convert: (s) => round(s / 3600, 4),
    outsideCatalog: true,
  },
  {
    field: "hr_min",
    measurement: "sleep-heart-rate",
    method: "session-minimum",
    outsideCatalog: true,
  },
  { field: "hr_max", measurement: MhcMeasurements.sleepHeartRateMaximum },
  { field: "rr_min", measurement: MhcMeasurements.sleepRespiratoryRateMinimum },
  { field: "rr_max", measurement: MhcMeasurements.sleepRespiratoryRateMaximum },
  {
    field: "total_timeinbed",
    measurement: MhcMeasurements.timeInBed,
    convert: minutes,
    method: "session-total",
  },
  { field: "sleep_score", measurement: MhcMeasurements.sleepScore },
  // Withings reports efficiency as a ratio in [0, 1].
  {
    field: "sleep_efficiency",
    measurement: MhcMeasurements.sleepEfficiency,
    convert: (r) => round(r * 100, 2),
  },
  {
    field: "sleep_latency",
    measurement: MhcMeasurements.sleepLatency,
    convert: minutes,
  },
  { field: "wakeupcount", measurement: MhcMeasurements.sleepAwakeningCount },
  {
    field: "snoring",
    measurement: MhcMeasurements.snoringDuration,
    convert: minutes,
    method: "session-total",
  },
  {
    field: "snoringepisodecount",
    measurement: MhcMeasurements.snoringEpisodeCount,
  },
  {
    field: "breathing_disturbances_intensity",
    measurement: MhcMeasurements.breathingDisturbanceIndex,
  },
];

const ACTIVITY_FIELDS: FieldMapping[] = [
  { field: "steps", measurement: "step-count" },
  { field: "distance", measurement: "distance" },
  { field: "calories", measurement: "active-energy" },
  {
    field: "totalcalories",
    measurement: MhcMeasurements.totalEnergyBurned,
    method: "daily-total",
  },
  {
    field: "elevation",
    measurement: MhcMeasurements.elevationGain,
    method: "daily-total",
  },
  {
    field: "soft",
    measurement: MhcMeasurements.lowActivityDuration,
    convert: minutes,
    method: "daily-total",
  },
  {
    field: "moderate",
    measurement: MhcMeasurements.mediumActivityDuration,
    convert: minutes,
    method: "daily-total",
  },
  {
    field: "intense",
    measurement: MhcMeasurements.highActivityDuration,
    convert: minutes,
    method: "daily-total",
  },
  {
    field: "active",
    measurement: MhcMeasurements.activeDuration,
    convert: minutes,
    method: "daily-total",
  },
];

export const normalizeWithings = (
  raw: WithingsRawData,
): ObservationRecordDraft[] => {
  const records: ObservationRecordDraft[] = [];

  for (const group of raw.measureGroups ?? []) {
    const zone: SourceZone = { iana: group.timezone ?? raw.measureTimezone };
    const effective = instant(group.date * 1000, zone);
    const recordingMethod = recordingMethodOf(group.attrib);
    const nativeId = String(group.grpid);
    const valueOf = (measure: WithingsMeasure) =>
      measure.value * Math.pow(10, measure.unit);

    for (const measure of group.measures) {
      const spec = MEASURE_TYPES[measure.type];
      if (spec !== undefined) {
        records.push(
          single(`getmeas:${measure.type}`, nativeId, {
            measurement: spec.measurement,
            effective,
            recordingMethod,
            value: {
              quantity: roundTo(valueOf(measure) * (spec.scale ?? 1), 4),
            },
          }),
        );
        continue;
      }
      const afib = AFIB_TYPES[measure.type];
      if (afib !== undefined && valueOf(measure) === 1) {
        records.push(
          single(`getmeas:${measure.type}`, nativeId, {
            measurement: afib,
            effective,
            recordingMethod,
            value: {
              concept: [
                {
                  system: `https://grovealliance.org/fhir/withings/CodeSystem/${afib}`,
                  code: "signs-detected",
                  display: "Signs Detected",
                },
              ],
            },
          }),
        );
      }
    }

    // Blood pressure: one panel only when exactly one systolic (10) and one
    // diastolic (9) value share this measure group; otherwise neither.
    const systolic = group.measures.filter((m) => m.type === 10);
    const diastolic = group.measures.filter((m) => m.type === 9);
    if (systolic.length === 1 && diastolic.length === 1) {
      const component = (code: string, value: number) => ({
        code: { system: GroveUrl.loinc, code },
        value: {
          quantity: roundTo(value, 2),
          unit: { code: "mm[Hg]", unit: "mmHg" },
        },
      });
      records.push(
        single("getmeas:9+10", nativeId, {
          measurement: "blood-pressure",
          effective,
          recordingMethod,
          components: [
            component("8480-6", valueOf(systolic[0])),
            component("8462-4", valueOf(diastolic[0])),
          ],
        }),
      );
    }
  }

  for (const activity of raw.activities ?? []) {
    const effective = civilDay(activity.date, { iana: activity.timezone });
    if (effective === undefined) continue;
    for (const mapping of ACTIVITY_FIELDS) {
      const rawValue = num(
        (activity as unknown as Record<string, unknown>)[mapping.field],
      );
      if (rawValue === undefined) continue;
      const value = mapping.convert ? mapping.convert(rawValue) : rawValue;
      if (value === undefined) continue;
      records.push(
        single(`getactivity:${mapping.field}`, activity.date, {
          measurement: mapping.measurement,
          effective,
          method: mapping.method,
          outsideCatalog: mapping.outsideCatalog,
          value: { quantity: value },
        }),
      );
    }
  }

  for (const series of raw.sleep ?? []) {
    if (!(series.enddate > series.startdate)) continue;
    const effective = period(series.startdate * 1000, series.enddate * 1000, {
      iana: series.timezone,
    });
    for (const mapping of SLEEP_FIELDS) {
      const rawValue = num(series.data?.[mapping.field]);
      if (rawValue === undefined) continue;
      const value = mapping.convert ? mapping.convert(rawValue) : rawValue;
      if (value === undefined) continue;
      records.push(
        single(`getsummary:${mapping.field}`, String(series.id), {
          measurement: mapping.measurement,
          effective,
          method: mapping.method,
          outsideCatalog: mapping.outsideCatalog,
          value: { quantity: value },
        }),
      );
    }
  }

  for (const workout of raw.workouts ?? []) {
    if (!(workout.enddate > workout.startdate)) continue;
    const effective = period(workout.startdate * 1000, workout.enddate * 1000, {
      iana: workout.timezone,
    });
    const data = workout.data ?? {};
    const activity =
      workout.category !== undefined ?
        (WORKOUT_CATEGORIES[workout.category] ??
        groveWorkoutActivity(undefined))
      : "other";
    records.push(
      single("getworkouts:interval", String(workout.id), {
        measurement: "workout",
        effective,
        recordingMethod: recordingMethodOf(workout.attrib),
        value: {
          concept: [
            { system: GroveUrl.workoutActivity, code: activity },
            ...(workout.category !== undefined ?
              [
                {
                  system: MhcUrl.providerToken("withings", "workout-category"),
                  code: String(workout.category),
                },
              ]
            : []),
          ],
        },
        components: [
          ...workoutComponent("active-duration", num(data.effduration), "s"),
          ...workoutComponent("active-energy-sum", num(data.calories), "kcal"),
          ...workoutComponent("distance-sum", num(data.distance), "m"),
          ...workoutComponent("heart-rate-avg", num(data.hr_average), "/min"),
          ...workoutComponent("heart-rate-max", num(data.hr_max), "/min"),
          ...workoutComponent("heart-rate-min", num(data.hr_min), "/min"),
          ...workoutComponent("step-count-sum", num(data.steps), "{steps}"),
          ...workoutComponent("elevation-gain", num(data.elevation), "m"),
          ...workoutComponent(
            "swimming-stroke-count-sum",
            num(data.strokes),
            "{strokes}",
          ),
          ...workoutComponent("pool-lap-count", num(data.pool_laps), "{laps}"),
        ],
      }),
    );
  }

  return records;
};

/**
 * Parse a Withings Notify POST (urlencoded) into a changed window. The
 * `startdate`/`enddate` here are attacker-controllable (the Notify callback has
 * no per-request signature), so the service clamps them to a bounded window
 * before fetching — see `HealthProviderService.ingestNotification`.
 */
export const parseWithingsNotification = (
  body: unknown,
): { providerUserId: string; since?: Date; until?: Date } | undefined => {
  const parsed = withingsNotificationSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const providerUserId = String(parsed.data.userid);
  if (providerUserId.length === 0) return undefined;
  const start = Number(parsed.data.startdate);
  const end = Number(parsed.data.enddate);
  return {
    providerUserId,
    since: Number.isFinite(start) ? new Date(start * 1000) : undefined,
    until: Number.isFinite(end) ? new Date(end * 1000) : undefined,
  };
};

/** Throw the right error for a non-zero Withings envelope status. */
export const checkWithingsEnvelope = (
  context: string,
  envelope: WithingsEnvelope<unknown>,
): void => {
  if (envelope.status === 0) return;
  const error = new Error(
    `${context} failed: status=${envelope.status} ${envelope.error ?? ""}`,
  );
  if (AUTH_FAILURE_STATUSES.has(envelope.status)) {
    throw new ProviderAuthError(context, error);
  }
  throw error;
};

export class WithingsAdapter implements HealthProviderAdapter {
  readonly id = HealthProviderId.withings;
  readonly scopes = WITHINGS_SCOPES;
  readonly usesPkce = false;

  buildAuthorizationUrl(params: {
    state: string;
    redirectUri: string;
  }): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", getWithingsClientId());
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", this.scopes.join(","));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<ProviderTokens> {
    const body = await this.oauth({
      action: "requesttoken",
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
    });
    return tokensFrom(body);
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    const body = await this.oauth({
      action: "requesttoken",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return tokensFrom(body);
  }

  async revoke(): Promise<void> {
    // Withings has no standalone token-revocation endpoint; removing the
    // notification subscriptions and deleting stored tokens is sufficient.
  }

  async ensureSubscription(params: {
    tokens: ProviderTokens;
    callbackUrl: string;
  }): Promise<{ subscriptionId?: string }> {
    for (const appli of NOTIFY_APPLI) {
      try {
        await this.call(NOTIFY_URL, params.tokens.accessToken, {
          action: "subscribe",
          callbackurl: params.callbackUrl,
          appli: String(appli),
          comment: "MyHeart Counts",
        });
      } catch (error) {
        logger.warn(
          `WithingsAdapter: subscribe appli=${appli} failed: ${String(error)}`,
        );
      }
    }
    return {};
  }

  async removeSubscription(params: {
    tokens: ProviderTokens;
    callbackUrl?: string;
  }): Promise<void> {
    // Withings `revoke` requires the exact `callbackurl` that was subscribed (in
    // addition to `appli`); omitting it makes the call fail with a non-zero
    // status and leaves the subscription live.
    if (!params.callbackUrl) {
      logger.warn(
        "WithingsAdapter: removeSubscription called without callbackUrl; skipping revoke",
      );
      return;
    }
    for (const appli of NOTIFY_APPLI) {
      try {
        await this.call(NOTIFY_URL, params.tokens.accessToken, {
          action: "revoke",
          callbackurl: params.callbackUrl,
          appli: String(appli),
        });
      } catch (error) {
        logger.warn(
          `WithingsAdapter: revoke appli=${appli} failed: ${String(error)}`,
        );
      }
    }
  }

  handleWebhook(req: Request, res: Response): WebhookHandling {
    // Withings verifies the callback is reachable with a GET/HEAD probe.
    if (req.method === "GET" || req.method === "HEAD") {
      res.status(200).send();
      return { kind: "verification" };
    }

    const parsed = parseWithingsNotification(req.body);
    if (parsed === undefined) {
      return { kind: "notifications", notifications: [] };
    }
    return {
      kind: "notifications",
      notifications: [
        {
          providerUserId: parsed.providerUserId,
          since: parsed.since,
          until: parsed.until,
        },
      ],
    };
  }

  async fetchData(params: FetchDataParams): Promise<ProviderFetchResult> {
    const { tokens, since, until } = params;
    const token = tokens.accessToken;
    const failures: string[] = [];
    const epochRange = {
      startdate: String(epochSeconds(since)),
      enddate: String(epochSeconds(until)),
    };
    const ymdRange = { startdateymd: ymd(since), enddateymd: ymd(until) };

    const [
      measures,
      activities,
      sleep,
      workouts,
      activityIntraday,
      sleepIntraday,
      rawOnly,
    ] = await Promise.all([
      settleEndpoint(
        "Withings getmeas",
        this.paged<WithingsMeasureGroup>(MEASURE_URL, token, "measuregrps", {
          action: "getmeas",
          meastypes: ALL_MEASURE_TYPES.join(","),
          category: "1",
          ...epochRange,
        }),
        failures,
      ),
      settleEndpoint(
        "Withings getactivity",
        this.paged<WithingsActivity>(V2_MEASURE_URL, token, "activities", {
          action: "getactivity",
          ...ymdRange,
          data_fields: ACTIVITY_FIELDS.map((f) => f.field).join(","),
        }),
        failures,
      ),
      settleEndpoint(
        "Withings getsummary",
        this.paged<WithingsSleepSummary>(V2_SLEEP_URL, token, "series", {
          action: "getsummary",
          ...ymdRange,
          data_fields: SLEEP_FIELDS.map((f) => f.field).join(","),
        }),
        failures,
      ),
      settleEndpoint(
        "Withings getworkouts",
        this.paged<WithingsWorkout>(V2_MEASURE_URL, token, "series", {
          action: "getworkouts",
          ...ymdRange,
          data_fields:
            "calories,distance,effduration,hr_average,hr_min,hr_max,steps,elevation,strokes,pool_laps",
        }),
        failures,
      ),
      // Intraday series are irregular/high frequency: kept verbatim as raw
      // recordings (catalog `mapped-standard`).
      settleEndpoint(
        "Withings getintradayactivity",
        this.call<unknown>(V2_MEASURE_URL, token, {
          action: "getintradayactivity",
          ...epochRange,
          data_fields: "steps,calories,distance,elevation,heart_rate,spo2_auto",
        }),
        failures,
      ),
      settleEndpoint(
        "Withings sleep get",
        this.call<unknown>(V2_SLEEP_URL, token, {
          action: "get",
          ...epochRange,
          data_fields: "hr,rr,snoring,sdnn_1,rmssd",
        }),
        failures,
      ),
      settleEndpoint(
        "Withings getmeas (segmental)",
        this.call<{ measuregrps?: unknown[] }>(MEASURE_URL, token, {
          action: "getmeas",
          meastypes: RAW_ONLY_MEASURE_TYPES.join(","),
          category: "1",
          ...epochRange,
        }),
        failures,
      ),
    ]);

    const rawArchives: ProviderRawArchive[] = [];
    if (activityIntraday !== undefined) {
      rawArchives.push({
        sourceType: "activityIntraday",
        dataType: "activityIntraday",
        typeText: "Withings intraday activity",
        payload: activityIntraday,
      });
    }
    if (sleepIntraday !== undefined) {
      rawArchives.push({
        sourceType: "sleepIntraday",
        dataType: "sleepIntraday",
        typeText: "Withings intraday sleep",
        payload: sleepIntraday,
      });
    }
    if ((rawOnly?.measuregrps?.length ?? 0) > 0) {
      rawArchives.push({
        sourceType: "getmeas:174+175",
        dataType: "measuresSegmental",
        typeText: "Withings segmental body composition",
        payload: rawOnly,
      });
    }

    return {
      records: normalizeWithings({
        measureGroups: measures?.items,
        measureTimezone: measures?.timezone,
        activities: activities?.items,
        sleep: sleep?.items,
        workouts: workouts?.items,
      }),
      rawArchives,
      failures,
    };
  }

  // Helpers ------------------------------------------------------------------

  private async oauth(
    params: Record<string, string>,
  ): Promise<WithingsTokenBody> {
    const body = new URLSearchParams({
      ...params,
      client_id: getWithingsClientId(),
      client_secret: getWithingsClientSecret(),
    });
    const envelope = await postJson<WithingsEnvelope<unknown>>(
      OAUTH_URL,
      { body },
      "Withings oauth",
    );
    if (envelope.status !== 0) {
      throw new Error(
        `Withings oauth failed: status=${envelope.status} ${envelope.error ?? ""}`,
      );
    }
    return withingsTokenBodySchema.parse(envelope.body);
  }

  /** Follow Withings `more`/`offset` pagination, concatenating `listKey`. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T types the concatenated list for callers
  private async paged<T>(
    url: string,
    accessToken: string,
    listKey: string,
    params: Record<string, string>,
  ): Promise<{ items: T[]; timezone?: string }> {
    const items: T[] = [];
    let timezone: string | undefined;
    let offset: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.call<Record<string, unknown>>(url, accessToken, {
        ...params,
        ...(offset !== undefined ? { offset } : {}),
      });
      const list = body[listKey];
      if (Array.isArray(list)) items.push(...(list as T[]));
      if (typeof body.timezone === "string") timezone ??= body.timezone;
      const more = body.more === true || body.more === 1 || body.more === "1";
      const nextOffset = body.offset;
      if (!more || nextOffset === undefined || nextOffset === null) {
        return { items, timezone };
      }
      offset = String(nextOffset as string | number);
    }
    throw new Error(`Withings ${params.action}: reached ${MAX_PAGES}-page cap`);
  }

  private async call<T>(
    url: string,
    accessToken: string,
    params: Record<string, string>,
  ): Promise<T> {
    const context = `Withings ${params.action}`;
    const envelope = await postJson<WithingsEnvelope<T>>(
      url,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: new URLSearchParams(params),
      },
      context,
    );
    checkWithingsEnvelope(context, envelope);
    return envelope.body;
  }
}
