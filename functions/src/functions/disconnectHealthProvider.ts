// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { validatedOnCall, privilegedServiceAccount } from "./helpers.js";
import { healthProviderSecretParams } from "../env.js";
import {
  disconnectHealthProviderInputSchema,
  type DisconnectHealthProviderOutput,
} from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

/**
 * Revokes a provider connection: removes the provider-side webhook
 * subscription, best-effort revokes the tokens, and deletes the stored
 * credentials and reverse-lookup index, leaving a `disconnected` status doc.
 */
export const disconnectHealthProvider = validatedOnCall(
  "disconnectHealthProvider",
  disconnectHealthProviderInputSchema,
  async (request): Promise<DisconnectHealthProviderOutput> => {
    const factory = getServiceFactory();
    const credential = factory.credential(request.auth);
    credential.checkUser(request.data.userId);

    await factory
      .healthProvider()
      .disconnect(request.data.userId, request.data.provider);

    return { status: "disconnected" };
  },
  {
    invoker: "public",
    serviceAccount: privilegedServiceAccount,
    secrets: healthProviderSecretParams,
  },
);
