// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Identifiers for the third-party health-data providers the backend can connect
 * to on a participant's behalf. Values double as the URL/collection-safe slug
 * used in webhook routes (`{provider}Webhook`) and observation collection
 * prefixes (`OuraObservations_*`).
 */
export enum HealthProviderId {
  oura = "oura",
  fitbit = "fitbit",
  withings = "withings",
}

export const allHealthProviderIds: HealthProviderId[] =
  Object.values(HealthProviderId);

export const healthProviderIdSchema = z.nativeEnum(HealthProviderId);

/**
 * Capitalized prefix for the per-provider FHIR observation collections, e.g.
 * `OuraObservations_heartRate`. Kept in sync with `PERMITTED_COLLECTION_PATTERN`
 * in the health-sample deletion queue.
 */
export const providerObservationCollectionPrefix = (
  provider: HealthProviderId,
): string => {
  const capitalized = provider.charAt(0).toUpperCase() + provider.slice(1);
  return `${capitalized}Observations`;
};

/**
 * Full collection name for a provider metric, e.g. ("oura", "heartRate") ->
 * "OuraObservations_heartRate". The metric suffix must be alphanumeric to
 * satisfy the deletion-queue collection pattern.
 */
export const providerObservationCollectionName = (
  provider: HealthProviderId,
  metric: string,
): string => `${providerObservationCollectionPrefix(provider)}_${metric}`;
