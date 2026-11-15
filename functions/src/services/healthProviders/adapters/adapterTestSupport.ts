// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

// Test-only helpers shared by the adapter unit tests.

import { type ProviderTokens } from "../../../models/index.js";
import { type MhcMeasurement } from "../grove/constants.js";
import {
  type ObservationDraft,
  type ObservationRecordDraft,
} from "../grove/drafts.js";

export const fakeTokens: ProviderTokens = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: new Date(Date.now() + 3600_000),
  scopes: [],
  providerUserId: "u",
};

/** Replace global fetch; `route` returns the JSON payload or a Response-like status. */
export const stubFetch = (
  route: (url: string, init?: RequestInit) => unknown,
): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : (input as { url: string }).url;
    const payload = route(url, init);
    if (payload instanceof Error) return Promise.reject(payload);
    const status =
      (payload as { __status?: number } | undefined)?.__status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () =>
        Promise.resolve(payload === undefined ? "" : JSON.stringify(payload)),
    } as Response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

const roleOf = (measurement: string | MhcMeasurement): string =>
  typeof measurement === "string" ? measurement : measurement.code;

/** All outputs (with their record) for a Grove measurement id or MHC code. */
export const outputsFor = (
  records: ObservationRecordDraft[],
  role: string,
): Array<{ record: ObservationRecordDraft; output: ObservationDraft }> =>
  records.flatMap((record) =>
    record.outputs
      .filter((output) => roleOf(output.measurement) === role)
      .map((output) => ({ record, output })),
  );

export const outputFor = (
  records: ObservationRecordDraft[],
  role: string,
): { record: ObservationRecordDraft; output: ObservationDraft } => {
  const match = outputsFor(records, role).at(0);
  if (match === undefined) throw new Error(`no output for ${role}`);
  return match;
};

export const quantityOf = (output: ObservationDraft): number | undefined =>
  output.value !== undefined && "quantity" in output.value ?
    output.value.quantity
  : undefined;
