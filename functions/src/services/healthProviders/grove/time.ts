// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Time helpers for Grove `effective[x]` values. Grove requires every value to
 * carry a time and a UTC offset, rounded to milliseconds; the source offset is
 * used when known, otherwise UTC (never an invented offset). The `timezone`
 * extension is added only when the source names an IANA zone.
 */

import { DateTime, FixedOffsetZone } from "luxon";

/** Where a provider value's local time comes from, best first. */
export interface SourceZone {
  /** IANA zone name, e.g. `Europe/Berlin` (Withings `timezone`). */
  iana?: string;
  /** Fixed UTC offset in minutes, e.g. parsed from an ISO-8601 timestamp. */
  offsetMinutes?: number;
}

export type GroveEffective =
  | { kind: "instant"; value: string; timezone?: string }
  | {
      kind: "period";
      start: string;
      end: string;
      /** IANA zone that applies to both bounds. */
      timezone?: string;
    };

const isValidZone = (iana: string | undefined): iana is string =>
  iana !== undefined &&
  iana.length > 0 &&
  DateTime.local().setZone(iana).isValid;

const zoned = (millis: number, zone: SourceZone | undefined): DateTime => {
  const utc = DateTime.fromMillis(Math.round(millis), { zone: "utc" });
  if (isValidZone(zone?.iana)) return utc.setZone(zone.iana);
  if (zone?.offsetMinutes !== undefined) {
    return utc.setZone(FixedOffsetZone.instance(zone.offsetMinutes));
  }
  return utc;
};

const format = (dateTime: DateTime): string => {
  const pattern =
    dateTime.millisecond === 0 ?
      "yyyy-MM-dd'T'HH:mm:ssZZ"
    : "yyyy-MM-dd'T'HH:mm:ss.SSSZZ";
  const text = dateTime.toFormat(pattern);
  // A zero offset is written as `Z` (same instant, same lexeme as iOS uploads).
  return dateTime.offset === 0 ? `${text.slice(0, -6)}Z` : text;
};

/** Format an instant in the source's zone (or UTC). */
export const formatInstant = (date: Date | number, zone?: SourceZone): string =>
  format(zoned(typeof date === "number" ? date : date.getTime(), zone));

/** Parse the UTC offset of an ISO-8601 timestamp (`Z`, `+02:00`, `-0700`). */
export const offsetOfIso = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (/[zZ]$/.test(value)) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
};

/** Parse a Google `Duration` string such as `-25200s` into minutes. */
export const offsetOfDuration = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(value);
  return match ? Math.round(Number(match[1]) / 60) : undefined;
};

/** Re-format an ISO-8601 timestamp keeping its own offset. */
export const normalizeIso = (
  value: string,
  zone?: SourceZone,
): string | undefined => {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return undefined;
  return formatInstant(millis, zone ?? { offsetMinutes: offsetOfIso(value) });
};

export const instant = (
  date: Date | number,
  zone?: SourceZone,
): GroveEffective => ({
  kind: "instant",
  value: formatInstant(date, zone),
  timezone: isValidZone(zone?.iana) ? zone.iana : undefined,
});

export const period = (
  start: Date | number,
  end: Date | number,
  zone?: SourceZone,
): GroveEffective => ({
  kind: "period",
  start: formatInstant(start, zone),
  end: formatInstant(end, zone),
  timezone: isValidZone(zone?.iana) ? zone.iana : undefined,
});

/**
 * A complete civil-day Period (`[day 00:00, next day 00:00)` local time),
 * which the provider catalog mandates for daily summaries (midpoint
 * substitution is forbidden). With an IANA zone the bounds follow DST; with a
 * fixed offset both bounds use it; without either the day is taken in UTC.
 */
export const civilDay = (
  day: string | { year: number; month: number; day: number },
  zone?: SourceZone,
): GroveEffective | undefined => {
  const parts =
    typeof day === "string" ?
      /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)?.slice(1).map(Number)
    : [day.year, day.month, day.day];
  if (parts?.length !== 3) return undefined;
  const [year, month, dayOfMonth] = parts;
  const luxonZone =
    isValidZone(zone?.iana) ? zone.iana
    : zone?.offsetMinutes !== undefined ?
      FixedOffsetZone.instance(zone.offsetMinutes)
    : "utc";
  const start = DateTime.fromObject(
    { year, month, day: dayOfMonth },
    { zone: luxonZone },
  );
  if (!start.isValid) return undefined;
  const end = start.plus({ days: 1 });
  return {
    kind: "period",
    start: format(start),
    end: format(end),
    timezone: isValidZone(zone?.iana) ? zone.iana : undefined,
  };
};

/** The UTC instant of a Grove effective value's start (for windows/occurred). */
export const effectiveStartMillis = (effective: GroveEffective): number =>
  Date.parse(effective.kind === "instant" ? effective.value : effective.start);
