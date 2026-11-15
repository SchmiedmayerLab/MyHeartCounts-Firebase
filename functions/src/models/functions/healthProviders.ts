// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { healthProviderIdSchema } from "../healthProviders/healthProviderId.js";

export const getHealthProviderAuthUrlInputSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  provider: healthProviderIdSchema,
});
export type GetHealthProviderAuthUrlInput = z.input<
  typeof getHealthProviderAuthUrlInputSchema
>;
export interface GetHealthProviderAuthUrlOutput {
  authorizationUrl: string;
}

export const disconnectHealthProviderInputSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  provider: healthProviderIdSchema,
});
export type DisconnectHealthProviderInput = z.input<
  typeof disconnectHealthProviderInputSchema
>;
export interface DisconnectHealthProviderOutput {
  status: "disconnected";
}

export const syncHealthProviderInputSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  provider: healthProviderIdSchema,
});
export type SyncHealthProviderInput = z.input<
  typeof syncHealthProviderInputSchema
>;
/**
 * `started`: a sync ran (its outcome is reflected in the connection document).
 * `throttled`: a sync was attempted less than 15 minutes ago; nothing was done.
 */
export interface SyncHealthProviderOutput {
  status: "started" | "throttled";
}

/**
 * Query parameters on the provider's OAuth redirect back to
 * `healthProviderOAuthCallback`. Everything here is untrusted external input, so
 * it is validated with zod rather than hand-rolled `typeof` checks. Express
 * parses repeated/array query params, so each field is coerced to a single
 * string and anything else is dropped to `undefined`.
 */
const singleString = z
  .unknown()
  .transform((value) => (typeof value === "string" ? value : undefined))
  .pipe(z.string().optional());

export const healthProviderOAuthCallbackQuerySchema = z.object({
  code: singleString,
  state: singleString,
  error: singleString,
});
export type HealthProviderOAuthCallbackQuery = z.output<
  typeof healthProviderOAuthCallbackQuerySchema
>;
