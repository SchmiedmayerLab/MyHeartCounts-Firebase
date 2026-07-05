// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { privilegedServiceAccount } from "./helpers.js";
import {
  getHealthProviderAppRedirectUrl,
  healthProviderSecretParams,
} from "../env.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

/**
 * Single redirect target for every provider's OAuth flow. The provider sends the
 * user here with `?code&state`; we exchange the code, persist tokens, register
 * the webhook subscription, then bounce the browser back into the app via a deep
 * link so the client can refresh its connection UI.
 */
export const healthProviderOAuthCallback = onRequest(
  {
    invoker: "public",
    serviceAccount: privilegedServiceAccount,
    secrets: healthProviderSecretParams,
  },
  async (req, res) => {
    const code =
      typeof req.query.code === "string" ? req.query.code : undefined;
    const state =
      typeof req.query.state === "string" ? req.query.state : undefined;
    const providerError =
      typeof req.query.error === "string" ? req.query.error : undefined;

    if (providerError) {
      logger.warn(
        `healthProviderOAuthCallback: provider error ${providerError}`,
      );
      res.redirect(
        302,
        `${getHealthProviderAppRedirectUrl()}/error?reason=${encodeURIComponent(providerError)}`,
      );
      return;
    }

    if (!code || !state) {
      res.status(400).send("Missing code or state");
      return;
    }

    try {
      const redirectUrl = await getServiceFactory()
        .healthProvider()
        .completeConnection(state, code);
      res.redirect(302, redirectUrl);
    } catch (error) {
      logger.error(
        `healthProviderOAuthCallback: failed to complete connection: ${String(error)}`,
      );
      res.redirect(
        302,
        `${getHealthProviderAppRedirectUrl()}/error?reason=connection_failed`,
      );
    }
  },
);
