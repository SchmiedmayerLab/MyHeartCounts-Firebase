// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { privilegedServiceAccount } from "./helpers.js";
import { healthProviderSecretParams } from "../env.js";
import { healthProviderIdSchema } from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";

/**
 * Whether a connection-document write is a new connection (first connect, or
 * a reconnect after disconnecting): `connectedAt` changed while the status is
 * `connected`. Sync bookkeeping writes never touch `connectedAt`, so they do
 * not re-trigger.
 */
export const isNewConnection = (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean => {
  if (after?.status !== "connected") return false;
  const afterConnectedAt = (
    after.connectedAt as Timestamp | null | undefined
  )?.toMillis();
  if (afterConnectedAt === undefined) return false;
  const beforeConnectedAt = (
    before?.connectedAt as Timestamp | null | undefined
  )?.toMillis();
  return beforeConnectedAt !== afterConnectedAt;
};

/**
 * Starts the initial 30-day history import as soon as a provider is connected,
 * so data appears without waiting for the daily backfill. Webhook ingests no
 * longer advance `lastSyncAt`, so a webhook arriving first cannot cut this
 * window short; if this run fails or is partial, the scheduled backfill retries
 * the full 30 days until `initialSyncCompletedAt` is set.
 */
export const onHealthProviderConnectionWritten = onDocumentWritten(
  {
    document: "users/{userId}/healthProviderConnections/{provider}",
    serviceAccount: privilegedServiceAccount,
    secrets: healthProviderSecretParams,
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!isNewConnection(before, after)) return;
    const provider = healthProviderIdSchema.safeParse(event.params.provider);
    if (!provider.success) return;
    try {
      await getServiceFactory()
        .healthProvider()
        .runInitialSync(event.params.userId, provider.data);
    } catch (error) {
      // Recorded on the connection document; the backfill retries.
      logger.warn(
        `onHealthProviderConnectionWritten: initial sync failed for ${provider.data}/${event.params.userId}: ${String(error)}`,
      );
    }
  },
);
