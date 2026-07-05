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
