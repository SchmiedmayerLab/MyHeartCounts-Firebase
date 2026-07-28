// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Response } from "express";
import { logger } from "firebase-functions/v2";
import { type Request, onRequest } from "firebase-functions/v2/https";
import { privilegedServiceAccount } from "./helpers.js";
import { healthProviderSecretParams } from "../env.js";
import { HealthProviderId } from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

// Each provider gets its own endpoint (`/{provider}Webhook`) because their
// verification handshakes and payloads differ; all three delegate to the shared
// orchestrator, which routes the provider user id to our account and ingests the
// changed window. The adapter owns verification/signature checks.
const makeWebhook = (provider: HealthProviderId) =>
  onRequest(
    {
      invoker: "public",
      serviceAccount: privilegedServiceAccount,
      secrets: healthProviderSecretParams,
    },
    async (req: Request, res: Response) => {
      try {
        await getServiceFactory()
          .healthProvider()
          .handleWebhook(provider, req, res);
      } catch (error) {
        logger.error(`${provider}Webhook: unhandled error: ${String(error)}`);
        if (!res.headersSent) {
          res.status(500).send("error");
        }
      }
    },
  );

export const ouraWebhook = makeWebhook(HealthProviderId.oura);
export const fitbitWebhook = makeWebhook(HealthProviderId.fitbit);
export const withingsWebhook = makeWebhook(HealthProviderId.withings);
