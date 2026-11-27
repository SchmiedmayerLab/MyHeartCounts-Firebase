// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { onSchedule } from "firebase-functions/v2/scheduler";
import { HealthSampleDeletionQueueService } from "../services/healthSamples/healthSampleDeletionQueueService.js";
import { privilegedServiceAccount } from "./helpers.js";

export const processPendingHealthSampleDeletions = onSchedule(
  {
    schedule: "every 2 hours",
    timeZone: "UTC",
    timeoutSeconds: 540,
    serviceAccount: privilegedServiceAccount,
  },
  async (_event) => {
    const queueService = new HealthSampleDeletionQueueService();
    await queueService.processQueue();
  },
);
