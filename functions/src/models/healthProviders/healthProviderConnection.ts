// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { HealthProviderId } from "./healthProviderId.js";
import { dateConverter } from "../helpers/dateConverter.js";
import { Lazy } from "../helpers/lazy.js";
import { optionalish } from "../helpers/optionalish.js";
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
        scopes: z.array(z.string()),
        connectedAt: optionalish(dateConverter.schema),
        lastSyncAt: optionalish(dateConverter.schema),
        lastSyncStatus: optionalish(z.nativeEnum(HealthProviderSyncStatus)),
        lastError: optionalish(z.string()),
      }),
      encode: (object) => ({
        provider: object.provider,
        status: object.status,
        scopes: object.scopes,
        connectedAt:
          object.connectedAt ? dateConverter.encode(object.connectedAt) : null,
        lastSyncAt:
          object.lastSyncAt ? dateConverter.encode(object.lastSyncAt) : null,
        lastSyncStatus: object.lastSyncStatus ?? null,
        lastError: object.lastError ?? null,
      }),
    }),
);

export type HealthProviderConnectionDocument = z.output<
  typeof healthProviderConnectionConverter.value.schema
>;
