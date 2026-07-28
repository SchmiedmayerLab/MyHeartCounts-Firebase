// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions/v2";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { privilegedServiceAccount } from "./helpers.js";
import { healthProviderSecretParams } from "../env.js";
import { allHealthProviderIds } from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

/**
 * Daily catch-up poll across every connected provider. Webhooks provide the
 * near-real-time path; this reaches the initial 30-day window seeded at connect
 * time and backfills anything missed while a webhook or subscription was down.
 */
export const healthProviderBackfill = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "UTC",
    serviceAccount: privilegedServiceAccount,
    secrets: healthProviderSecretParams,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const service = getServiceFactory().healthProvider();
    for (const provider of allHealthProviderIds) {
      try {
        await service.backfillProvider(provider);
      } catch (error) {
        logger.error(
          `healthProviderBackfill: ${provider} failed: ${String(error)}`,
        );
      }
    }
  },
);
