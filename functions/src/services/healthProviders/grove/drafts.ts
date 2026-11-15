// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Provider-neutral, pre-FHIR description of what an adapter extracted from a
 * provider response. Adapters only describe *what* a source record says; the
 * {@link buildExchangeBundles} step turns drafts into Grove Observations,
 * DocumentReferences, Provenance and the exchange Bundle, adding identity,
 * subject, profiles and extensions uniformly.
 */

import {
  type AggregationMethod,
  type Coding,
  GroveUrl,
  type MhcMeasurement,
  type QuantityUnit,
} from "./constants.js";
import { type GroveEffective } from "./time.js";

export type RecordingMethod =
  | "manual-entry"
  | "actively-recorded"
  | "automatically-recorded";

export interface DraftComponent {
  code: Coding;
  value:
    | { quantity: number; unit: QuantityUnit }
    | { concept: Coding[]; text?: string };
}

export interface ObservationDraft {
  /**
   * Grove measurement id (`measurement-catalog.json`), or an MHC extra
   * measurement for fields no Grove profile models.
   */
  measurement: string | MhcMeasurement;
  /** Output discriminator; `single` unless a record repeats one output role. */
  discriminator?: string;
  effective: GroveEffective;
  value?:
    | { quantity: number; unit?: QuantityUnit }
    | { concept: Coding[]; text?: string }
    | { text: string };
  method?: AggregationMethod;
  components?: DraftComponent[];
  recordingMethod?: RecordingMethod;
  /**
   * Force the out-of-catalog tag even though the measurement id is admitted
   * for this source type (e.g. a second, non-catalog field mapped to the same
   * Grove measurement with a different method).
   */
  outsideCatalog?: boolean;
  /** Output keys (`role|discriminator`) within the same record to reference via `hasMember`. */
  hasMember?: string[];
}

export interface ObservationRecordDraft {
  kind: "observations";
  /** Bare catalog token, e.g. `daily_activity`, `getmeas:9+10`, `steps`. */
  sourceType: string;
  /** The provider's native record id (or a persisted opaque import key). */
  nativeRecordId: string;
  /** Source activity time, used for `Provenance.occurred[x]`. */
  occurred: GroveEffective;
  outputs: ObservationDraft[];
}

export interface RecordingRecordDraft {
  kind: "recording";
  sourceType: string;
  nativeRecordId: string;
  occurred: GroveEffective;
  /** Human-readable `DocumentReference.type.text`. */
  typeText: string;
  /** Uncompressed exact JSON bytes as stored; hash and size describe these. */
  payload: Buffer;
  /** Retrievable location of the stored payload. */
  url: string;
}

export type RecordDraft = ObservationRecordDraft | RecordingRecordDraft;

export const aggregation = (method: AggregationMethod): Coding => ({
  system: GroveUrl.aggregationMethod,
  code: method,
});

/** Workout statistic component (`grove-workout-statistic`). */
export const workoutComponent = (
  code: string,
  quantity: number | undefined,
  unitCode: string,
): DraftComponent[] =>
  quantity === undefined || !Number.isFinite(quantity) ?
    []
  : [
      {
        code: { system: GroveUrl.workoutStatistic, code },
        value: { quantity, unit: { code: unitCode, unit: unitCode } },
      },
    ];

/** Output key used for `hasMember` references within a record. */
export const outputKey = (role: string, discriminator = "single"): string =>
  `${role}|${discriminator}`;

/** Defensive numeric read of an int64-as-string or number field. */
export const num = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Round to a fixed number of decimals, avoiding binary noise like 7.199999. */
export const round = (
  value: number | undefined,
  decimals = 3,
): number | undefined =>
  value === undefined ? undefined : Number(value.toFixed(decimals));

/** {@link round} for a known number. */
export const roundTo = (value: number, decimals = 3): number =>
  Number(value.toFixed(decimals));

/** UTC calendar date `YYYY-MM-DD` of an instant (provider query windows). */
export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** Seconds → minutes, rounded to 2 decimals; `undefined` when not numeric. */
export const minutesFromSeconds = (seconds: unknown): number | undefined => {
  const value = num(seconds);
  return value === undefined ? undefined : roundTo(value / 60, 2);
};

/** Scaled, rounded draft quantity; `undefined` when not numeric. */
export const quantityValue = (
  value: unknown,
  scale = 1,
  decimals = 4,
): { quantity: number } | undefined => {
  const parsed = num(value);
  return parsed === undefined ? undefined : (
      { quantity: roundTo(parsed * scale, decimals) }
    );
};
