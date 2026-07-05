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

/**
 * Short-lived pending-OAuth record at the root collection
 * `healthProviderAuthRequests/{state}`. Ties an opaque `state` value back to the
 * requesting user and provider across the redirect round-trip, and carries the
 * PKCE `codeVerifier` for providers that use PKCE (Fitbit). It is server-only
 * (root collections default-deny in firestore.rules) and consumed exactly once
 * in the OAuth callback.
 */
export const healthProviderAuthRequestConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z.object({
        provider: z.nativeEnum(HealthProviderId),
        userId: z.string(),
        state: z.string(),
        redirectUri: z.string(),
        codeVerifier: optionalish(z.string()),
        createdAt: dateConverter.schema,
        expiresAt: dateConverter.schema,
      }),
      encode: (object) => ({
        provider: object.provider,
        userId: object.userId,
        state: object.state,
        redirectUri: object.redirectUri,
        codeVerifier: object.codeVerifier ?? null,
        createdAt: dateConverter.encode(object.createdAt),
        expiresAt: dateConverter.encode(object.expiresAt),
      }),
    }),
);

export type HealthProviderAuthRequestDocument = z.output<
  typeof healthProviderAuthRequestConverter.value.schema
>;

/**
 * Reverse-lookup record at the root collection
 * `healthProviderUserIndex/{provider}:{providerUserId}` mapping a provider's own
 * user id back to our Firebase uid, so inbound webhooks (which only carry the
 * provider user id) can be routed to the right account without a collection-group
 * query. Server-only.
 */
export const healthProviderUserIndexConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z.object({
        provider: z.nativeEnum(HealthProviderId),
        providerUserId: z.string(),
        userId: z.string(),
      }),
      encode: (object) => ({
        provider: object.provider,
        providerUserId: object.providerUserId,
        userId: object.userId,
      }),
    }),
);

export type HealthProviderUserIndexDocument = z.output<
  typeof healthProviderUserIndexConverter.value.schema
>;

export const healthProviderUserIndexId = (
  provider: HealthProviderId,
  providerUserId: string,
): string => `${provider}:${providerUserId}`;
