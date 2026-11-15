// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { https } from "firebase-functions/v2";
import { validatedOnCall, privilegedServiceAccount } from "./helpers.js";
import { healthProviderSecretParams } from "../env.js";
import {
  syncHealthProviderInputSchema,
  type SyncHealthProviderOutput,
} from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

/**
 * Pull new data for one provider connection now (pull-to-refresh). Throttled
 * to one attempt per 15 minutes per connection; returns `throttled` instead of
 * syncing within that window. The sync outcome is written to the connection
 * document (`lastSyncAt`, `lastSyncStatus`, `lastError`), not returned.
 */
export const syncHealthProvider = validatedOnCall(
  "syncHealthProvider",
  syncHealthProviderInputSchema,
  async (request): Promise<SyncHealthProviderOutput> => {
    const factory = getServiceFactory();
    const credential = factory.credential(request.auth);
    credential.checkUser(request.data.userId);

    const result = await factory
      .healthProvider()
      .requestSync(request.data.userId, request.data.provider);
    if (result === "not_connected") {
      throw new https.HttpsError(
        "failed-precondition",
        "The provider is not connected.",
      );
    }
    return { status: result };
  },
  {
    invoker: "public",
    serviceAccount: privilegedServiceAccount,
    secrets: healthProviderSecretParams,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
);
