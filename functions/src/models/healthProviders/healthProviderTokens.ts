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
 * OAuth material returned by a provider adapter after a code exchange or refresh.
 * This is the in-memory shape passed around the service layer; the persisted
 * document (see `healthProviderTokenConverter`) adds bookkeeping fields.
 *
 * SECURITY: instances of this type contain live access/refresh tokens. They are
 * only ever stored in the server-only `users/{uid}/healthProviderTokens`
 * subcollection (locked down in firestore.rules) and must never be returned to
 * clients or logged.
 */
export interface ProviderTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of `accessToken`. */
  expiresAt: Date;
  scopes: string[];
  /** The provider's own identifier for the user (used for webhook routing). */
  providerUserId: string;
}

export const healthProviderTokenConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z.object({
        provider: z.nativeEnum(HealthProviderId),
        accessToken: z.string(),
        refreshToken: z.string(),
        expiresAt: dateConverter.schema,
        scopes: z.array(z.string()),
        providerUserId: z.string(),
        updatedAt: dateConverter.schema,
        subscriptionId: optionalish(z.string()),
      }),
      encode: (object) => ({
        provider: object.provider,
        accessToken: object.accessToken,
        refreshToken: object.refreshToken,
        expiresAt: dateConverter.encode(object.expiresAt),
        scopes: object.scopes,
        providerUserId: object.providerUserId,
        updatedAt: dateConverter.encode(object.updatedAt),
        subscriptionId: object.subscriptionId ?? null,
      }),
    }),
);

export type HealthProviderTokenDocument = z.output<
  typeof healthProviderTokenConverter.value.schema
>;
