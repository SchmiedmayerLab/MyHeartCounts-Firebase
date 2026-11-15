// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { HealthProviderId } from "./healthProviderId.js";
import { dateConverter } from "../helpers/dateConverter.js";
import { Lazy } from "../helpers/lazy.js";
import { SchemaConverter } from "../helpers/schemaConverter.js";

export enum HealthProviderConnectionStatus {
  connected = "connected",
  disconnected = "disconnected",
  error = "error",
}

export enum HealthProviderSyncStatus {
  ok = "ok",
  error = "error",
}

/**
 * Sanitized, client-facing error codes in `lastError`. Raw provider error
 * bodies are logged server-side only.
 * - `auth_failed`: the provider rejected our credentials; the user must
 *   reconnect (connection `status` is `error`).
 * - `provider_unavailable`: the provider failed or rate-limited every request.
 * - `partial_failure`: some endpoints failed; what arrived was stored and the
 *   window is retried on the next sync.
 * - `unknown`: anything else (e.g. a storage failure on our side).
 */
export enum HealthProviderSyncError {
  authFailed = "auth_failed",
  providerUnavailable = "provider_unavailable",
  partialFailure = "partial_failure",
  unknown = "unknown",
}

/** `null`/absent stay `undefined` (the shared dateConverter maps null to now). */
const nullableDate = z
  .union([z.null(), z.undefined(), dateConverter.schema])
  .transform((value) => value ?? undefined);

const encodeDate = (date: Date | undefined) =>
  date ? dateConverter.encode(date) : null;

/**
 * Client-readable status document at
 * `users/{uid}/healthProviderConnections/{provider}`. Deliberately contains no
 * tokens or other secrets — it exists so the mobile apps can render connection
 * state and last-sync info via a Firestore listener. It is written by the server
 * only (firestore.rules denies client writes).
 */
export const healthProviderConnectionConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z.object({
        provider: z.nativeEnum(HealthProviderId),
        status: z.nativeEnum(HealthProviderConnectionStatus),
        scopes: z.array(z.string()).default([]),
        connectedAt: nullableDate,
        /** Upper bound of the last fully successful window sync. */
        lastSyncAt: nullableDate,
        /** When any sync (webhook, scheduled, manual) last started. */
        lastSyncAttemptAt: nullableDate,
        /** Set once the initial 30-day history import fully succeeded. */
        initialSyncCompletedAt: nullableDate,
        lastSyncStatus: z
          .nativeEnum(HealthProviderSyncStatus)
          .nullish()
          .transform((value) => value ?? undefined),
        lastError: z
          .nativeEnum(HealthProviderSyncError)
          .nullish()
          .catch(HealthProviderSyncError.unknown)
          .transform((value) => value ?? undefined),
      }),
      encode: (object) => ({
        provider: object.provider,
        status: object.status,
        scopes: object.scopes,
        connectedAt: encodeDate(object.connectedAt),
        lastSyncAt: encodeDate(object.lastSyncAt),
        lastSyncAttemptAt: encodeDate(object.lastSyncAttemptAt),
        initialSyncCompletedAt: encodeDate(object.initialSyncCompletedAt),
        lastSyncStatus: object.lastSyncStatus ?? null,
        lastError: object.lastError ?? null,
      }),
    }),
);

export type HealthProviderConnectionDocument = z.output<
  typeof healthProviderConnectionConverter.value.schema
>;
