// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { validatedOnCall, privilegedServiceAccount } from "./helpers.js";
import { healthProviderSecretParams } from "../env.js";
import {
  getHealthProviderAuthUrlInputSchema,
  type GetHealthProviderAuthUrlOutput,
} from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

/**
 * Returns the provider authorization URL the mobile app opens in a web-auth
 * session. All the OAuth heavy lifting (state minting, PKCE, token exchange)
 * happens server-side; the app only needs to open this URL and await the
 * deep-link callback.
 */
export const getHealthProviderAuthUrl = validatedOnCall(
  "getHealthProviderAuthUrl",
  getHealthProviderAuthUrlInputSchema,
  async (request): Promise<GetHealthProviderAuthUrlOutput> => {
    const factory = getServiceFactory();
    const credential = factory.credential(request.auth);
    credential.checkUser(request.data.userId);

    const authorizationUrl = await factory
      .healthProvider()
      .startConnection(request.data.userId, request.data.provider);

    return { authorizationUrl };
  },
  {
    invoker: "public",
    serviceAccount: privilegedServiceAccount,
    secrets: healthProviderSecretParams,
  },
);
