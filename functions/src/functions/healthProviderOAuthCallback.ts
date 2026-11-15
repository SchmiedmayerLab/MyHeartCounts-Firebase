// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { privilegedServiceAccount } from "./helpers.js";
import { healthProviderSecretParams } from "../env.js";
import { healthProviderOAuthCallbackQuerySchema } from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";
import {
  HealthProviderConnectionError,
  HealthProviderService,
} from "../services/healthProviders/healthProviderService.js";

/**
 * Single redirect target for every provider's OAuth flow. The provider sends the
 * user here with `?code&state` (or `?error&state`); we exchange the code,
 * persist tokens, register the webhook subscription, then bounce the browser
 * back into the app via a deep link:
 * - `{APP_REDIRECT}/{provider}/connected`
 * - `{APP_REDIRECT}/{provider}/error?reason=…` (provider known from the state)
 * - `{APP_REDIRECT}/error?reason=…` (state missing, unknown or already used)
 */
export const healthProviderOAuthCallback = onRequest(
  {
    invoker: "public",
    serviceAccount: privilegedServiceAccount,
    secrets: healthProviderSecretParams,
  },
  async (req, res) => {
    const service = getServiceFactory().healthProvider();
    const query = healthProviderOAuthCallbackQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.redirect(302, HealthProviderService.errorRedirect("invalid_request"));
      return;
    }
    const { code, state, error: providerError } = query.data;

    if (providerError) {
      logger.warn(
        `healthProviderOAuthCallback: provider error ${providerError}`,
      );
      const provider = await service.abandonConnection(state);
      res.redirect(
        302,
        HealthProviderService.errorRedirect(providerError, provider),
      );
      return;
    }

    if (!code || !state) {
      const provider = await service.abandonConnection(state);
      res.redirect(
        302,
        HealthProviderService.errorRedirect("invalid_request", provider),
      );
      return;
    }

    try {
      res.redirect(302, await service.completeConnection(state, code));
    } catch (error) {
      logger.error(
        `healthProviderOAuthCallback: failed to complete connection: ${String(error)}`,
      );
      const connectionError =
        error instanceof HealthProviderConnectionError ? error : undefined;
      res.redirect(
        302,
        HealthProviderService.errorRedirect(
          connectionError?.reason ?? "connection_failed",
          connectionError?.provider,
        ),
      );
    }
  },
);
