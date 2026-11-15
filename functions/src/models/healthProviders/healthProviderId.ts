// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Identifiers for the third-party health-data providers the backend can connect
 * to on a participant's behalf. Values double as the URL/path-safe slug used in
 * webhook routes (`{provider}Webhook`), connection document ids and Cloud
 * Storage paths (`users/{uid}/providerHealthSamples/{provider}/…`).
 */
export enum HealthProviderId {
  oura = "oura",
  googleHealth = "googleHealth",
  withings = "withings",
}

export const allHealthProviderIds: HealthProviderId[] =
  Object.values(HealthProviderId);

export const healthProviderIdSchema = z.nativeEnum(HealthProviderId);
