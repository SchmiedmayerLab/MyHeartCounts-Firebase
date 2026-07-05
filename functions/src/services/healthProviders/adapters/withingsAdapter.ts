// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Response } from "express";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import { getWithingsClientId, getWithingsClientSecret } from "../../../env.js";
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
import { postJson } from "../httpClient.js";
import { buildProviderObservation } from "../observationBuilder.js";
import { MetricSpecs, type MetricSpec } from "../providerCodes.js";

const AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
const OAUTH_URL = "https://wbsapi.withings.net/v2/oauth2";
const MEASURE_URL = "https://wbsapi.withings.net/measure";
const V2_MEASURE_URL = "https://wbsapi.withings.net/v2/measure";
const V2_SLEEP_URL = "https://wbsapi.withings.net/v2/sleep";
const NOTIFY_URL = "https://wbsapi.withings.net/notify";

const WITHINGS_SCOPES = ["user.metrics", "user.activity", "user.info"];

/** Withings `appli` notification categories we subscribe to. */
const NOTIFY_APPLI = [1 /* weight */, 16 /* activity */, 44 /* sleep */];

/** Withings integer measure types -> shared metric specs (getmeas). */
const MEASURE_TYPE_SPECS = new Map<number, MetricSpec>([
  [1, MetricSpecs.bodyWeight],
  [6, MetricSpecs.bodyFatPercentage],
  [11, MetricSpecs.heartRate],
  [54, MetricSpecs.oxygenSaturation],
  [71, MetricSpecs.bodyTemperature],
]);

const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);
const ymd = (date: Date): string => date.toISOString().slice(0, 10);
const minutesFromSeconds = (seconds: number | null | undefined): number =>
  Math.round(((seconds ?? 0) / 60) * 100) / 100;

// --- Raw response shapes (only the fields we consume) ----------------------

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

interface WithingsMeasure {
  value: number;
  type: number;
  unit: number;
}
interface WithingsMeasureGroup {
  grpid: number;
  date: number;
  measures: WithingsMeasure[];
}
interface WithingsActivity {
  date: string;
  steps?: number;
  distance?: number;
  calories?: number;
}
interface WithingsSleepSeries {
  id: number;
  startdate: number;
  enddate: number;
  date?: string;
  data?: {
    deepsleepduration?: number;
    remsleepduration?: number;
    lightsleepduration?: number;
    wakeupduration?: number;
    hr_average?: number;
    rr_average?: number;
  };
}

const tokensFrom = (body: WithingsTokenBody): ProviderTokens => ({
  accessToken: body.access_token,
  refreshToken: body.refresh_token,
  expiresAt: new Date(Date.now() + body.expires_in * 1000),
  scopes: body.scope ? body.scope.split(",") : WITHINGS_SCOPES,
  providerUserId: String(body.userid),
});

// --- Pure normalization (exported for unit tests) --------------------------

const midday = (day: string): Date => new Date(`${day}T12:00:00Z`);

export const normalizeWithings = (
  raw: {
    measureGroups?: WithingsMeasureGroup[];
    activities?: WithingsActivity[];
    sleep?: WithingsSleepSeries[];
  },
  subject: FHIRReference,
): ProviderObservation[] => {
  const out: ProviderObservation[] = [];
  const add = (
    spec: MetricSpec,
    value: number | undefined,
    effective: Date | { start: Date; end: Date },
    sampleId: string,
  ) => {
    if (value === undefined || Number.isNaN(value)) return;
    out.push(
      buildProviderObservation({
        provider: HealthProviderId.withings,
        sourceName: "Withings",
        subject,
        spec,
        value,
        effective,
        sampleId,
      }),
    );
  };

  for (const group of raw.measureGroups ?? []) {
    const effective = new Date(group.date * 1000);
    for (const measure of group.measures) {
      const spec = MEASURE_TYPE_SPECS.get(measure.type);
      if (!spec) continue;
      const value = measure.value * Math.pow(10, measure.unit);
      add(spec, value, effective, `${group.grpid}-${measure.type}`);
    }
  }

  for (const activity of raw.activities ?? []) {
    add(
      MetricSpecs.steps,
      activity.steps,
      midday(activity.date),
      activity.date,
    );
    add(
      MetricSpecs.distanceWalkingRunning,
      activity.distance,
      midday(activity.date),
      activity.date,
    );
    add(
      MetricSpecs.activeEnergyBurned,
      activity.calories,
      midday(activity.date),
      activity.date,
    );
  }

  for (const series of raw.sleep ?? []) {
    const period = {
      start: new Date(series.startdate * 1000),
      end: new Date(series.enddate * 1000),
    };
    const id = String(series.id);
    add(
      MetricSpecs.sleepDeep,
      minutesFromSeconds(series.data?.deepsleepduration),
      period,
      id,
    );
    add(
      MetricSpecs.sleepRem,
      minutesFromSeconds(series.data?.remsleepduration),
      period,
      id,
    );
    add(
      MetricSpecs.sleepLight,
      minutesFromSeconds(series.data?.lightsleepduration),
      period,
      id,
    );
    add(
      MetricSpecs.sleepAwake,
      minutesFromSeconds(series.data?.wakeupduration),
      period,
      id,
    );
    add(
      MetricSpecs.restingHeartRate,
      series.data?.hr_average,
      period.start,
      id,
    );
    add(MetricSpecs.respiratoryRate, series.data?.rr_average, period.start, id);
  }

  return out;
};

/** Parse a Withings Notify POST (urlencoded) into a changed window. */
export const parseWithingsNotification = (
  body: unknown,
): { providerUserId: string; since?: Date; until?: Date } | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const form = body as Record<string, unknown>;
  const userid = form.userid;
  const providerUserId =
    typeof userid === "string" ? userid
    : typeof userid === "number" ? String(userid)
    : undefined;
  if (providerUserId === undefined || providerUserId.length === 0) {
    return undefined;
  }
  const start = Number(form.startdate);
  const end = Number(form.enddate);
  return {
    providerUserId,
    since: Number.isFinite(start) ? new Date(start * 1000) : undefined,
    until: Number.isFinite(end) ? new Date(end * 1000) : undefined,
  };
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

  async removeSubscription(params: { tokens: ProviderTokens }): Promise<void> {
    // Withings revoke needs the exact callbackurl that was subscribed; it is not
    // stored per-appli, so this is best-effort using the current base URL.
    for (const appli of NOTIFY_APPLI) {
      try {
        await this.call(NOTIFY_URL, params.tokens.accessToken, {
          action: "revoke",
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

  async fetchObservations(
    params: FetchObservationsParams,
  ): Promise<ProviderObservation[]> {
    const { tokens, since, until, subject } = params;
    const token = tokens.accessToken;

    const [measures, activity, sleep] = await Promise.all([
      this.call<{ measuregrps?: WithingsMeasureGroup[] }>(MEASURE_URL, token, {
        action: "getmeas",
        meastypes: Array.from(MEASURE_TYPE_SPECS.keys()).join(","),
        category: "1",
        startdate: String(epochSeconds(since)),
        enddate: String(epochSeconds(until)),
      }),
      this.call<{ activities?: WithingsActivity[] }>(V2_MEASURE_URL, token, {
        action: "getactivity",
        startdateymd: ymd(since),
        enddateymd: ymd(until),
        data_fields: "steps,distance,calories",
      }),
      this.call<{ series?: WithingsSleepSeries[] }>(V2_SLEEP_URL, token, {
        action: "getsummary",
        startdateymd: ymd(since),
        enddateymd: ymd(until),
        data_fields:
          "deepsleepduration,remsleepduration,lightsleepduration,wakeupduration,hr_average,rr_average",
      }),
    ]);

    return normalizeWithings(
      {
        measureGroups: measures.measuregrps,
        activities: activity.activities,
        sleep: sleep.series,
      },
      subject,
    );
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
    const envelope = await postJson<WithingsEnvelope<WithingsTokenBody>>(
      OAUTH_URL,
      { body },
      "Withings oauth",
    );
    if (envelope.status !== 0) {
      throw new Error(
        `Withings oauth failed: status=${envelope.status} ${envelope.error ?? ""}`,
      );
    }
    return envelope.body;
  }

  private async call<T>(
    url: string,
    accessToken: string,
    params: Record<string, string>,
  ): Promise<T> {
    const envelope = await postJson<WithingsEnvelope<T>>(
      url,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        body: new URLSearchParams(params),
      },
      `Withings ${params.action}`,
    );
    if (envelope.status !== 0) {
      throw new Error(
        `Withings ${params.action} failed: status=${envelope.status} ${envelope.error ?? ""}`,
      );
    }
    return envelope.body;
  }
}
