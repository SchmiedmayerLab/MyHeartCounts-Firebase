// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Response } from "express";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import { z } from "zod";
import {
  getGoogleHealthClientId,
  getGoogleHealthClientSecret,
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
  num,
  type ObservationDraft,
  type ObservationRecordDraft,
  outputKey,
  quantityValue as quantity,
  type RecordingMethod,
  workoutComponent,
} from "../grove/drafts.js";
import {
  civilDay,
  formatInstant,
  type GroveEffective,
  instant,
  offsetOfDuration,
  offsetOfIso,
  period,
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

// This adapter targets the Google Health API (health.googleapis.com/v4), the
// successor of the legacy Fitbit Web API (sunsetting September 2026). Endpoint
// shapes follow the API discovery document. Optional fields read below that are
// not covered by the test fixtures (data point `name`, `dataSource`, UTC offsets,
// sleep `stages`, exercise summaries) are read defensively.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API_BASE = "https://health.googleapis.com/v4";

const GOOGLE_HEALTH_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
];

/** Safety cap on token-paginated fetches. */
const MAX_PAGES = 1000;

const physicalTimeFilter = (field: string, since: Date, until: Date): string =>
  `${field} >= "${since.toISOString()}" AND ${field} < "${until.toISOString()}"`;

const civilDateFilter = (field: string, since: Date, until: Date): string =>
  `${field} >= "${isoDate(since)}" AND ${field} < "${isoDate(until)}"`;

interface GoogleHealthDate {
  year: number;
  month: number;
  day: number;
}

const dateKey = (date: GoogleHealthDate): string =>
  `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

// --- Raw response shapes ------------------------------------------------------
// Int64 fields (count, millimeters, beatsPerMinute, minutes, ...) are encoded
// as JSON strings by the Google Health API and are parsed with `num`.

interface GoogleHealthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

interface GHInterval {
  startTime: string;
  endTime: string;
  startUtcOffset?: string;
  endUtcOffset?: string;
}
interface GHSampleTime {
  physicalTime: string;
  utcOffset?: string;
}
interface GHSleepStage {
  startTime?: string;
  endTime?: string;
  type?: string;
}
interface GHSleep {
  interval: GHInterval;
  type?: string;
  summary?: {
    minutesAsleep?: string;
    minutesAwake?: string;
    minutesInSleepPeriod?: string;
    minutesToFallAsleep?: string;
    stagesSummary?: Array<{ type?: string; minutes?: string; count?: string }>;
  };
  stages?: GHSleepStage[];
}
interface GHExercise {
  interval: GHInterval;
  exerciseType?: string;
  activeDuration?: string;
  metricsSummary?: Record<string, unknown>;
}

const googleHealthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().optional(),
    expires_in: z.number(),
    scope: z.string().optional(),
  })
  .passthrough();

const googleHealthIdentitySchema = z
  .object({ healthUserId: z.string().min(1) })
  .passthrough();

const googleHealthPageEnvelopeSchema = z
  .object({
    dataPoints: z.array(z.record(z.unknown())).optional(),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

const tokensFrom = (
  response: GoogleHealthTokenResponse,
  providerUserId: string,
  fallbackRefreshToken?: string,
): ProviderTokens => {
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (refreshToken === undefined) {
    throw new Error(
      "Google Health token response omitted refresh_token and no prior refresh token is available",
    );
  }
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + response.expires_in * 1000),
    scopes: response.scope ? response.scope.split(" ") : GOOGLE_HEALTH_SCOPES,
    providerUserId,
  };
};

// --- Normalization helpers -------------------------------------------------------

type DataPoint = Record<string, unknown> & {
  name?: unknown;
  dataSource?: { recordingMethod?: unknown } & Record<string, unknown>;
};

/** The data point's own id (last segment of its resource `name`). */
const nativeIdOf = (point: DataPoint, fallback: string): string => {
  if (typeof point.name === "string" && point.name.length > 0) {
    const segments = point.name.split("/");
    return segments[segments.length - 1] || point.name;
  }
  // No native id: fall back to the (type, time) key the API reconciles on.
  return fallback;
};

const recordingMethodOf = (point: DataPoint): RecordingMethod | undefined => {
  const method = point.dataSource?.recordingMethod;
  if (typeof method !== "string") return undefined;
  const upper = method.toUpperCase();
  if (upper.includes("MANUAL")) return "manual-entry";
  if (upper.includes("PASSIVE") || upper.includes("AUTOMATIC")) {
    return "automatically-recorded";
  }
  if (upper.includes("ACTIVE")) return "actively-recorded";
  return undefined;
};

const intervalEffective = (
  interval: GHInterval | undefined,
): GroveEffective | undefined => {
  if (!interval?.startTime || !interval.endTime) return undefined;
  const start = Date.parse(interval.startTime);
  const end = Date.parse(interval.endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start)
    return undefined;
  const offsetMinutes =
    offsetOfDuration(interval.startUtcOffset) ??
    offsetOfIso(interval.startTime);
  return period(start, end, { offsetMinutes });
};

const sampleEffective = (
  sampleTime: GHSampleTime | undefined,
): GroveEffective | undefined => {
  if (!sampleTime?.physicalTime) return undefined;
  const millis = Date.parse(sampleTime.physicalTime);
  if (Number.isNaN(millis)) return undefined;
  const offsetMinutes =
    offsetOfDuration(sampleTime.utcOffset) ??
    offsetOfIso(sampleTime.physicalTime);
  return instant(millis, { offsetMinutes });
};

const record = (
  sourceType: string,
  nativeRecordId: string,
  occurred: GroveEffective,
  outputs: ObservationDraft[],
): ObservationRecordDraft[] =>
  outputs.length === 0 ?
    []
  : [{ kind: "observations", sourceType, nativeRecordId, occurred, outputs }];

const SLEEP_STAGE_CODES: Record<string, string> = {
  AWAKE: "awake",
  LIGHT: "light",
  DEEP: "deep",
  REM: "rem",
  ASLEEP: "asleep-unspecified",
  OUT_OF_BED: "out-of-bed",
  IN_BED: "in-bed",
};

export interface GoogleHealthRawData {
  steps?: unknown[];
  distance?: unknown[];
  activeEnergyBurned?: unknown[];
  weight?: unknown[];
  bodyFat?: unknown[];
  height?: unknown[];
  vo2Max?: unknown[];
  dailyOxygenSaturation?: unknown[];
  heartRateVariability?: unknown[];
  dailyRestingHeartRate?: unknown[];
  dailyRespiratoryRate?: unknown[];
  bloodGlucose?: unknown[];
  coreBodyTemperature?: unknown[];
  floors?: unknown[];
  basalEnergyBurned?: unknown[];
  sleep?: unknown[];
  exercise?: unknown[];
}

// --- Pure normalization (exported for unit tests) --------------------------

export const normalizeGoogleHealth = (
  raw: GoogleHealthRawData,
): ObservationRecordDraft[] => {
  const records: ObservationRecordDraft[] = [];
  const points = (list: unknown[] | undefined) => (list ?? []) as DataPoint[];

  /** Interval-valued totals (`steps`, `distance`, …). */
  const intervalTotals = (
    list: unknown[] | undefined,
    unionKey: string,
    sourceType: string,
    measurement: string,
    valueKey: string,
    scale = 1,
  ) => {
    for (const point of points(list)) {
      const value = point[unionKey] as
        | (Record<string, unknown> & { interval?: GHInterval })
        | undefined;
      if (!value) continue;
      const effective = intervalEffective(value.interval);
      const q = quantity(value[valueKey], scale);
      if (!effective || !q) continue;
      records.push(
        ...record(
          sourceType,
          nativeIdOf(point, `${sourceType}-${value.interval?.startTime}`),
          effective,
          [
            {
              measurement,
              effective,
              value: q,
              recordingMethod: recordingMethodOf(point),
            },
          ],
        ),
      );
    }
  };

  /** Sample-valued measurements (`weight`, `height`, …). */
  const samples = (
    list: unknown[] | undefined,
    unionKey: string,
    sourceType: string,
    measurement: string,
    valueKey: string,
    scale = 1,
  ) => {
    for (const point of points(list)) {
      const value = point[unionKey] as
        | (Record<string, unknown> & { sampleTime?: GHSampleTime })
        | undefined;
      if (!value) continue;
      const effective = sampleEffective(value.sampleTime);
      const q = quantity(value[valueKey], scale);
      if (!effective || !q) continue;
      records.push(
        ...record(
          sourceType,
          nativeIdOf(point, `${sourceType}-${value.sampleTime?.physicalTime}`),
          effective,
          [
            {
              measurement,
              effective,
              value: q,
              recordingMethod: recordingMethodOf(point),
            },
          ],
        ),
      );
    }
  };

  /**
   * Daily summaries carry only a civil date; the API gives no offset for
   * them, so the day is taken in UTC (the Grove `mobile-omission.source-offset`
   * case).
   */
  const daily = (
    list: unknown[] | undefined,
    unionKey: string,
    sourceType: string,
    build: (
      value: Record<string, unknown>,
      effective: GroveEffective,
    ) => ObservationDraft[],
  ) => {
    for (const point of points(list)) {
      const value = point[unionKey] as
        | (Record<string, unknown> & { date?: GoogleHealthDate })
        | undefined;
      if (!value?.date) continue;
      const effective = civilDay(value.date);
      if (!effective) continue;
      records.push(
        ...record(
          sourceType,
          nativeIdOf(point, `${sourceType}-${dateKey(value.date)}`),
          effective,
          build(value, effective),
        ),
      );
    }
  };

  intervalTotals(raw.steps, "steps", "steps", "step-count", "count");
  intervalTotals(
    raw.distance,
    "distance",
    "distance",
    "distance",
    "millimeters",
    1 / 1000,
  );
  intervalTotals(
    raw.activeEnergyBurned,
    "activeEnergyBurned",
    "active-energy-burned",
    "active-energy",
    "kcal",
  );
  intervalTotals(raw.floors, "floors", "floors", "flights-climbed", "count");
  intervalTotals(
    raw.basalEnergyBurned,
    "basalEnergyBurned",
    "basal-energy-burned",
    "basal-energy",
    "kcal",
  );

  samples(
    raw.weight,
    "weight",
    "weight",
    "body-weight",
    "weightGrams",
    1 / 1000,
  );
  samples(
    raw.bodyFat,
    "bodyFat",
    "body-fat",
    "body-fat-percentage",
    "percentage",
  );
  samples(
    raw.height,
    "height",
    "height",
    "body-height",
    "heightMillimeters",
    1 / 10,
  );
  samples(raw.vo2Max, "vo2Max", "vo2-max", "vo2-max", "vo2Max");
  samples(
    raw.bloodGlucose,
    "bloodGlucose",
    "blood-glucose",
    "blood-glucose-unspecified-specimen",
    "bloodGlucoseMilligramsPerDeciliter",
  );
  samples(
    raw.coreBodyTemperature,
    "coreBodyTemperature",
    "core-body-temperature",
    "body-temperature",
    "temperatureCelsius",
  );

  // HRV: both statistics of one sample are outputs of one record.
  for (const point of points(raw.heartRateVariability)) {
    const value = point.heartRateVariability as
      | {
          rootMeanSquareOfSuccessiveDifferencesMilliseconds?: unknown;
          standardDeviationMilliseconds?: unknown;
          sampleTime?: GHSampleTime;
        }
      | undefined;
    if (!value) continue;
    const effective = sampleEffective(value.sampleTime);
    if (!effective) continue;
    const recordingMethod = recordingMethodOf(point);
    const outputs: ObservationDraft[] = [];
    const rmssd = quantity(
      value.rootMeanSquareOfSuccessiveDifferencesMilliseconds,
    );
    const sdnn = quantity(value.standardDeviationMilliseconds);
    if (rmssd)
      outputs.push({
        measurement: "heart-rate-variability-rmssd",
        effective,
        value: rmssd,
        recordingMethod,
      });
    if (sdnn)
      outputs.push({
        measurement: "heart-rate-variability-sdnn",
        effective,
        value: sdnn,
        recordingMethod,
      });
    records.push(
      ...record(
        "heart-rate-variability",
        nativeIdOf(
          point,
          `heart-rate-variability-${value.sampleTime?.physicalTime}`,
        ),
        effective,
        outputs,
      ),
    );
  }

  daily(
    raw.dailyOxygenSaturation,
    "dailyOxygenSaturation",
    "daily-oxygen-saturation",
    (value, effective) => {
      const outputs: ObservationDraft[] = [];
      const average = quantity(value.averagePercentage);
      const lower = quantity(value.lowerBoundPercentage);
      const upper = quantity(value.upperBoundPercentage);
      if (average)
        outputs.push({
          measurement: "oxygen-saturation-daily-average",
          effective,
          value: average,
        });
      if (lower)
        outputs.push({
          measurement: MhcMeasurements.oxygenSaturationDailyLowerBound,
          effective,
          value: lower,
        });
      if (upper)
        outputs.push({
          measurement: MhcMeasurements.oxygenSaturationDailyUpperBound,
          effective,
          value: upper,
        });
      return outputs;
    },
  );
  daily(
    raw.dailyRestingHeartRate,
    "dailyRestingHeartRate",
    "daily-resting-heart-rate",
    (value, effective) => {
      const q = quantity(value.beatsPerMinute);
      return q ?
          [
            {
              measurement: "resting-heart-rate-daily-average",
              effective,
              value: q,
            },
          ]
        : [];
    },
  );
  daily(
    raw.dailyRespiratoryRate,
    "dailyRespiratoryRate",
    "daily-respiratory-rate",
    (value, effective) => {
      const q = quantity(value.breathsPerMinute);
      return q ?
          [
            {
              measurement: "respiratory-rate-average",
              effective,
              value: q,
              method: "daily-mean",
            },
          ]
        : [];
    },
  );

  for (const point of points(raw.sleep)) {
    const value = point.sleep as GHSleep | undefined;
    if (!value) continue;
    const effective = intervalEffective(value.interval);
    if (!effective) continue;
    const offsetMinutes =
      offsetOfDuration(value.interval.startUtcOffset) ??
      offsetOfIso(value.interval.startTime);
    const summary = value.summary;
    const stageMinutes = (type: string) =>
      quantity(
        summary?.stagesSummary?.find((stage) => stage.type === type)?.minutes,
      );
    const outputs: ObservationDraft[] = [];

    // Stage timeline: Grove sleep-stage intervals (catalog: deferred for
    // providers, so tagged out-of-catalog), linked from the sleep duration.
    const stageKeys: string[] = [];
    (value.stages ?? []).forEach((stage, index) => {
      if (!stage.startTime || !stage.endTime || !stage.type) return;
      const start = Date.parse(stage.startTime);
      const end = Date.parse(stage.endTime);
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return;
      const code = SLEEP_STAGE_CODES[stage.type.toUpperCase()] ?? "unknown";
      const discriminator = `${formatInstant(start)}|${formatInstant(end)}|${stage.type}|${index}`;
      stageKeys.push(outputKey("sleep-stage", discriminator));
      outputs.push({
        measurement: "sleep-stage",
        discriminator,
        outsideCatalog: true,
        effective: period(start, end, { offsetMinutes }),
        value: {
          concept: [
            { system: GroveUrl.sleepStage, code },
            {
              system: MhcUrl.providerToken("google-health", "sleep-stage"),
              code: stage.type,
            },
          ],
        },
      });
    });

    const asleep = quantity(summary?.minutesAsleep, 1 / 60);
    if (asleep) {
      outputs.push({
        measurement: "sleep-duration",
        effective,
        value: asleep,
        hasMember: stageKeys,
      });
    }
    const deep = stageMinutes("DEEP");
    const rem = stageMinutes("REM");
    const light = stageMinutes("LIGHT");
    const awake = stageMinutes("AWAKE");
    if (deep)
      outputs.push({
        measurement: "deep-sleep-duration",
        effective,
        value: deep,
      });
    if (rem)
      outputs.push({
        measurement: "rem-sleep-duration",
        effective,
        value: rem,
      });
    if (light)
      outputs.push({
        measurement: "light-sleep-duration",
        effective,
        value: light,
      });
    if (awake)
      outputs.push({
        measurement: "sleep-awake-duration",
        effective,
        value: awake,
      });
    const latency = quantity(summary?.minutesToFallAsleep);
    if (latency)
      outputs.push({
        measurement: MhcMeasurements.sleepLatency,
        effective,
        value: latency,
      });
    const inBed = quantity(summary?.minutesInSleepPeriod);
    if (inBed) {
      outputs.push({
        measurement: MhcMeasurements.timeInBed,
        effective,
        value: inBed,
        method: "session-total",
      });
    }
    if (value.type) {
      outputs.push({
        measurement: MhcMeasurements.sleepPeriodType,
        effective,
        value: {
          concept: [
            {
              system: MhcUrl.providerToken("google-health", "sleep-type"),
              code: value.type,
            },
          ],
          text: value.type,
        },
      });
    }
    records.push(
      ...record(
        "sleep",
        nativeIdOf(point, `sleep-${value.interval.startTime}`),
        effective,
        outputs,
      ),
    );
  }

  for (const point of points(raw.exercise)) {
    const value = point.exercise as GHExercise | undefined;
    if (!value) continue;
    const effective = intervalEffective(value.interval);
    if (!effective) continue;
    const summary = value.metricsSummary ?? {};
    const activeSeconds =
      typeof value.activeDuration === "string" ?
        num(value.activeDuration.replace(/s$/, ""))
      : undefined;
    const distanceMm = num(summary.distanceMillimeters);
    const elevationMm = num(summary.elevationGainMillimeters);
    records.push(
      ...record(
        "exercise",
        nativeIdOf(point, `exercise-${value.interval.startTime}`),
        effective,
        [
          {
            measurement: "workout",
            effective,
            recordingMethod: recordingMethodOf(point),
            value: {
              concept: [
                {
                  system: GroveUrl.workoutActivity,
                  code: groveWorkoutActivity(value.exerciseType),
                },
                ...(value.exerciseType ?
                  [
                    {
                      system: MhcUrl.providerToken(
                        "google-health",
                        "exercise-type",
                      ),
                      code: value.exerciseType,
                    },
                  ]
                : []),
              ],
            },
            components: [
              ...workoutComponent("active-duration", activeSeconds, "s"),
              ...workoutComponent(
                "active-energy-sum",
                num(summary.caloriesKcal),
                "kcal",
              ),
              ...workoutComponent(
                "distance-sum",
                distanceMm === undefined ? undefined : distanceMm / 1000,
                "m",
              ),
              ...workoutComponent(
                "step-count-sum",
                num(summary.steps),
                "{steps}",
              ),
              ...workoutComponent(
                "heart-rate-avg",
                num(summary.averageHeartRateBeatsPerMinute),
                "/min",
              ),
              ...workoutComponent(
                "elevation-gain",
                elevationMm === undefined ? undefined : elevationMm / 1000,
                "m",
              ),
            ],
          },
        ],
      ),
    );
  }

  return records;
};

export class GoogleHealthAdapter implements HealthProviderAdapter {
  readonly id = HealthProviderId.googleHealth;
  readonly scopes = GOOGLE_HEALTH_SCOPES;
  readonly usesPkce = false;

  buildAuthorizationUrl(params: {
    state: string;
    redirectUri: string;
  }): string {
    const url = new URL(AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", getGoogleHealthClientId());
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", params.state);
    // Google only returns a refresh_token on the first consent for a given
    // client/user pair unless re-consent is forced; MHC always needs one.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<ProviderTokens> {
    const response = googleHealthTokenResponseSchema.parse(
      await postJson<unknown>(
        TOKEN_URL,
        {
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: params.code,
            redirect_uri: params.redirectUri,
            client_id: getGoogleHealthClientId(),
            client_secret: getGoogleHealthClientSecret(),
          }),
        },
        "Google Health token exchange",
      ),
    );
    const providerUserId = await this.fetchHealthUserId(response.access_token);
    return tokensFrom(response, providerUserId);
  }

  async refreshTokens(refreshToken: string): Promise<ProviderTokens> {
    const response = googleHealthTokenResponseSchema.parse(
      await postJson<unknown>(
        TOKEN_URL,
        {
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: getGoogleHealthClientId(),
            client_secret: getGoogleHealthClientSecret(),
          }),
        },
        "Google Health token refresh",
      ),
    );
    // Google omits the user id (and often the refresh token) on refresh.
    return tokensFrom(response, "", refreshToken);
  }

  async revoke(tokens: ProviderTokens): Promise<void> {
    // Revoking the refresh token also invalidates its access tokens.
    const response = await fetch(
      `${REVOKE_URL}?${new URLSearchParams({ token: tokens.refreshToken }).toString()}`,
      { method: "POST" },
    );
    if (!response.ok) {
      throw new ProviderHttpError(
        response.status,
        await response.text(),
        "Google Health revoke",
      );
    }
  }

  ensureSubscription(): Promise<{ subscriptionId?: string }> {
    // Google Health push subscriptions require a project-level Subscriber
    // (endpoint verification + a signed-webhook secret) on top of the
    // per-user Subscription. Not implemented yet — the scheduled backfill and
    // the syncHealthProvider callable poll instead.
    logger.warn(
      "GoogleHealthAdapter: push subscriptions are not implemented; relying on polling.",
    );
    return Promise.resolve({});
  }

  async removeSubscription(): Promise<void> {
    // No subscription is ever created (see ensureSubscription).
  }

  handleWebhook(_req: Request, res: Response): WebhookHandling {
    // No subscriber is ever registered with Google, so this route should
    // never receive real traffic.
    res.status(204).send();
    return { kind: "verification" };
  }

  async fetchData(params: FetchDataParams): Promise<ProviderFetchResult> {
    const { tokens, since, until } = params;
    const token = tokens.accessToken;
    const failures: string[] = [];
    const physical = (field: string) => physicalTimeFilter(field, since, until);
    const daily = (field: string) => civilDateFilter(field, since, until);
    const fetch = (dataType: string, filter: string) =>
      settleEndpoint(
        `GoogleHealth ${dataType}`,
        this.paginate(dataType, filter, token, "dataPoints:reconcile"),
        failures,
      );

    const [
      steps,
      distance,
      activeEnergyBurned,
      weight,
      bodyFat,
      height,
      vo2Max,
      dailyOxygenSaturation,
      heartRateVariability,
      dailyRestingHeartRate,
      dailyRespiratoryRate,
      bloodGlucose,
      coreBodyTemperature,
      floors,
      basalEnergyBurned,
      sleep,
      exercise,
      heartRate,
    ] = await Promise.all([
      fetch("steps", physical("steps.interval.start_time")),
      fetch("distance", physical("distance.interval.start_time")),
      fetch(
        "active-energy-burned",
        physical("active_energy_burned.interval.start_time"),
      ),
      fetch("weight", physical("weight.sample_time.physical_time")),
      fetch("body-fat", physical("body_fat.sample_time.physical_time")),
      fetch("height", physical("height.sample_time.physical_time")),
      fetch("vo2-max", physical("vo2_max.sample_time.physical_time")),
      fetch("daily-oxygen-saturation", daily("daily_oxygen_saturation.date")),
      fetch(
        "heart-rate-variability",
        physical("heart_rate_variability.sample_time.physical_time"),
      ),
      fetch("daily-resting-heart-rate", daily("daily_resting_heart_rate.date")),
      fetch("daily-respiratory-rate", daily("daily_respiratory_rate.date")),
      fetch(
        "blood-glucose",
        physical("blood_glucose.sample_time.physical_time"),
      ),
      fetch(
        "core-body-temperature",
        physical("core_body_temperature.sample_time.physical_time"),
      ),
      fetch("floors", physical("floors.interval.start_time")),
      fetch(
        "basal-energy-burned",
        physical("basal_energy_burned.interval.start_time"),
      ),
      fetch("sleep", physical("sleep.interval.end_time")),
      fetch("exercise", daily("exercise.interval.civil_start_time")),
      // Raw (non-reconciled) heart rate is kept as a recording document.
      settleEndpoint(
        "GoogleHealth heart-rate",
        this.paginate(
          "heart-rate",
          physical("heart_rate.sample_time.physical_time"),
          token,
          "dataPoints",
        ),
        failures,
      ),
    ]);

    return {
      records: normalizeGoogleHealth({
        steps,
        distance,
        activeEnergyBurned,
        weight,
        bodyFat,
        height,
        vo2Max,
        dailyOxygenSaturation,
        heartRateVariability,
        dailyRestingHeartRate,
        dailyRespiratoryRate,
        bloodGlucose,
        coreBodyTemperature,
        floors,
        basalEnergyBurned,
        sleep,
        exercise,
      }),
      rawArchives:
        heartRate !== undefined && heartRate.length > 0 ?
          [
            {
              sourceType: "heart-rate",
              dataType: "heartRate",
              typeText: "Google Health API heart-rate archive",
              payload: heartRate,
            },
          ]
        : [],
      failures,
    };
  }

  // Helpers ------------------------------------------------------------------

  private async fetchHealthUserId(accessToken: string): Promise<string> {
    const identity = googleHealthIdentitySchema.parse(
      await getJson<unknown>(
        `${API_BASE}/users/me/identity`,
        accessToken,
        "Google Health identity",
      ),
    );
    return identity.healthUserId;
  }

  private async paginate(
    dataType: string,
    filter: string,
    token: string,
    pathSuffix: "dataPoints:reconcile" | "dataPoints",
  ): Promise<unknown[]> {
    const results: unknown[] = [];
    let pageToken: string | undefined;
    let guard = 0;
    do {
      const searchParams = new URLSearchParams({ filter, pageSize: "1000" });
      if (pageToken) searchParams.set("pageToken", pageToken);
      const page = googleHealthPageEnvelopeSchema.parse(
        await getJson<unknown>(
          `${API_BASE}/users/me/dataTypes/${dataType}/${pathSuffix}?${searchParams.toString()}`,
          token,
          `Google Health ${dataType}`,
        ),
      );
      results.push(...(page.dataPoints ?? []));
      // `??` would keep an empty-string nextPageToken (Google's "no more
      // pages" signal) and loop forever; the falsy check is required here.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      pageToken = page.nextPageToken ? page.nextPageToken : undefined;
      guard++;
    } while (pageToken !== undefined && guard < MAX_PAGES);
    if (pageToken !== undefined) {
      throw new Error(
        `Google Health ${dataType}: reached ${MAX_PAGES}-page cap`,
      );
    }
    return results;
  }
}
