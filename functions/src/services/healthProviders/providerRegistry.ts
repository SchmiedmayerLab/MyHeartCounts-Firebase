// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { FitbitAdapter } from "./adapters/fitbitAdapter.js";
import { OuraAdapter } from "./adapters/ouraAdapter.js";
import { WithingsAdapter } from "./adapters/withingsAdapter.js";
import { type HealthProviderAdapter } from "./healthProviderAdapter.js";
import { HealthProviderId } from "../../models/index.js";

// Adapters are stateless — they read their credentials from Secret Manager at
// call time — so a single shared instance per provider is safe.
const adapters: Record<HealthProviderId, HealthProviderAdapter> = {
  [HealthProviderId.oura]: new OuraAdapter(),
  [HealthProviderId.fitbit]: new FitbitAdapter(),
  [HealthProviderId.withings]: new WithingsAdapter(),
};

export const getAdapter = (provider: HealthProviderId): HealthProviderAdapter =>
  adapters[provider];
