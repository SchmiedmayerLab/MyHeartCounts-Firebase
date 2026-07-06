// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHash, randomBytes } from "crypto";
import { type Response } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import {
  type HealthProviderAdapter,
  type ProviderObservation,
  type ProviderWebhookNotification,
  type WebhookHandling,
} from "./healthProviderAdapter.js";
import { ProviderAuthError, ProviderHttpError } from "./httpClient.js";
import { getAdapter } from "./providerRegistry.js";
import {
  getHealthProviderBaseUrl,
  getHealthProviderAppRedirectUrl,
} from "../../env.js";
import {
  type FHIRReference,
  HealthProviderConnectionStatus,
  type HealthProviderId,
  HealthProviderSyncStatus,
  healthProviderUserIndexId,
  type ProviderTokens,
  providerObservationCollectionName,
} from "../../models/index.js";
import { type DatabaseService } from "../database/databaseService.js";

/** How far back the first scheduled backfill reaches after a fresh connection. */
const INITIAL_BACKFILL_DAYS = 30;
/** Refresh access tokens this long before their nominal expiry. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/**
 * Upper bound on how far back a webhook-triggered fetch may reach. Webhook
 * bodies (notably Withings Notify) carry a caller-supplied `startdate` with no
 * per-request signature, so the window is clamped here to prevent a forged
 * notification from forcing an unbounded backfill on a victim's token. Deeper
 * history is covered by the daily scheduled backfill.
 */
const WEBHOOK_MAX_LOOKBACK_DAYS = 7;

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** Whether an ingest error indicates the stored credentials are unusable. */
const isAuthFailure = (error: unknown): boolean =>
  error instanceof ProviderAuthError ||
  (error instanceof ProviderHttpError && error.isAuthFailure);

const base64url = (buffer: Buffer): string =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export class HealthProviderService {
  private readonly databaseService: DatabaseService;
  private readonly resolveAdapter: (
    provider: HealthProviderId,
  ) => HealthProviderAdapter;

  constructor(
    databaseService: DatabaseService,
    // Injectable so tests can substitute a fake adapter without hitting provider
    // networks; production uses the real registry.
    resolveAdapter: (
      provider: HealthProviderId,
    ) => HealthProviderAdapter = getAdapter,
  ) {
    this.databaseService = databaseService;
    this.resolveAdapter = resolveAdapter;
  }

  // URLs ---------------------------------------------------------------------

  private get callbackUrl(): string {
    return `${getHealthProviderBaseUrl()}/healthProviderOAuthCallback`;
  }

  private webhookUrl(provider: HealthProviderId): string {
    return `${getHealthProviderBaseUrl()}/${provider}Webhook`;
  }

  private subject(userId: string): FHIRReference {
    return { reference: `user/${userId}` };
  }

  // Connection lifecycle -----------------------------------------------------

  /**
   * Begin an OAuth connection: persist a one-time state record (carrying a PKCE
   * verifier where needed) and return the provider authorization URL the client
   * opens for consent.
   */
  async startConnection(
    userId: string,
    provider: HealthProviderId,
  ): Promise<string> {
    const adapter = this.resolveAdapter(provider);
    const state = base64url(randomBytes(32));
    const codeVerifier =
      adapter.usesPkce ? base64url(randomBytes(32)) : undefined;
    const codeChallenge =
      codeVerifier ?
        base64url(createHash("sha256").update(codeVerifier).digest())
      : undefined;
    const redirectUri = this.callbackUrl;

    await this.databaseService.setDocument(
      (collections) => collections.healthProviderAuthRequests.doc(state),
      {
        provider,
        userId,
        state,
        redirectUri,
        codeVerifier,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    );

    return adapter.buildAuthorizationUrl({ state, redirectUri, codeChallenge });
  }

  /**
   * Complete an OAuth connection from the provider's redirect: validate/consume
   * the state record, exchange the code, persist tokens, register the webhook
   * subscription and reverse-lookup index, and mark the connection connected.
   * Returns the app deep link the callback should redirect the browser to.
   */
  async completeConnection(state: string, code: string): Promise<string> {
    const authRequest = await this.databaseService.getDocument((collections) =>
      collections.healthProviderAuthRequests.doc(state),
    );
    if (authRequest === undefined) {
      throw new Error("Unknown or expired OAuth state.");
    }
    if (authRequest.content.expiresAt.getTime() < Date.now()) {
      throw new Error("OAuth state has expired.");
    }

    const { provider, userId, redirectUri, codeVerifier } = authRequest.content;
    const adapter = this.resolveAdapter(provider);

    const tokens = await adapter.exchangeCode({
      code,
      redirectUri,
      codeVerifier,
    });

    let subscriptionId: string | undefined;
    try {
      const result = await adapter.ensureSubscription({
        tokens,
        callbackUrl: this.webhookUrl(provider),
      });
      subscriptionId = result.subscriptionId;
    } catch (error) {
      // A missing subscription degrades to scheduled-poll only; don't fail the
      // whole connection over it.
      logger.error(
        `HealthProviderService: ensureSubscription failed for ${provider}/${userId}: ${String(error)}`,
      );
    }

    await this.storeTokens(userId, provider, tokens, subscriptionId);

    // Add this user to the reverse index (a set-union so a provider account
    // shared across two MHC accounts routes to both). Kept out of the bulkWrite
    // below because it is a read-modify-write on a shared root doc.
    await this.addUserToIndex(provider, tokens.providerUserId, userId);

    await this.databaseService.bulkWrite(async (collections, writer) => {
      // The per-op promises can't be awaited here: the bulkWrite wrapper closes
      // the writer only after this callback returns, so awaiting them would
      // deadlock. flush() commits the buffered writes and resolves when done.
      void writer.set(
        collections.healthProviderConnections(userId).doc(provider),
        {
          provider,
          status: HealthProviderConnectionStatus.connected,
          scopes: tokens.scopes,
          connectedAt: new Date(),
          // Seed the first scheduled backfill to reach INITIAL_BACKFILL_DAYS back.
          lastSyncAt: daysAgo(INITIAL_BACKFILL_DAYS),
          lastSyncStatus: undefined,
          lastError: undefined,
        },
      );
      void writer.delete(collections.healthProviderAuthRequests.doc(state));
      await writer.flush();
    });

    return `${getHealthProviderAppRedirectUrl()}/${provider}/connected`;
  }

  /** Revoke and remove a provider connection. Best-effort at the provider. */
  async disconnect(userId: string, provider: HealthProviderId): Promise<void> {
    const tokenDoc = await this.databaseService.getDocument((collections) =>
      collections.healthProviderTokens(userId).doc(provider),
    );

    if (tokenDoc !== undefined) {
      const adapter = this.resolveAdapter(provider);
      const tokens: ProviderTokens = tokenDoc.content;
      try {
        await adapter.removeSubscription({
          tokens,
          subscriptionId: tokenDoc.content.subscriptionId,
          callbackUrl: this.webhookUrl(provider),
        });
      } catch (error) {
        logger.error(
          `HealthProviderService: removeSubscription failed for ${provider}/${userId}: ${String(error)}`,
        );
      }
      try {
        await adapter.revoke(tokens);
      } catch (error) {
        logger.error(
          `HealthProviderService: revoke failed for ${provider}/${userId}: ${String(error)}`,
        );
      }
      // Remove only this user from the (possibly shared) reverse index.
      await this.removeUserFromIndex(
        provider,
        tokenDoc.content.providerUserId,
        userId,
      );
    }

    await this.databaseService.bulkWrite(async (collections, writer) => {
      void writer.delete(
        collections.healthProviderTokens(userId).doc(provider),
      );
      // Full overwrite (no merge) resets the status document cleanly.
      void writer.set(
        collections.healthProviderConnections(userId).doc(provider),
        {
          provider,
          status: HealthProviderConnectionStatus.disconnected,
          scopes: [],
          connectedAt: undefined,
          lastSyncAt: undefined,
          lastSyncStatus: undefined,
          lastError: undefined,
        },
      );
      await writer.flush();
    });
  }

  /**
   * Tear down every provider connection for a user. Used on account deletion so
   * provider-side webhook subscriptions and the root reverse-index entries (which
   * `recursiveDelete(users/{uid})` does not touch) are cleaned up before the
   * user's documents are removed.
   */
  async disconnectAll(userId: string): Promise<void> {
    const tokenDocs = await this.databaseService.getQuery((collections) =>
      collections.healthProviderTokens(userId),
    );
    for (const tokenDoc of tokenDocs) {
      try {
        await this.disconnect(userId, tokenDoc.content.provider);
      } catch (error) {
        logger.error(
          `HealthProviderService: disconnectAll failed for ${tokenDoc.content.provider}/${userId}: ${String(error)}`,
        );
      }
    }
  }

  // Reverse index -------------------------------------------------------------

  /** Add a user to a provider-account's reverse-index entry (set-union). */
  private async addUserToIndex(
    provider: HealthProviderId,
    providerUserId: string,
    userId: string,
  ): Promise<void> {
    await this.databaseService.runTransaction(async (collections, tx) => {
      const ref = collections.healthProviderUserIndex.doc(
        healthProviderUserIndexId(provider, providerUserId),
      );
      const snap = await tx.get(ref);
      const existing = snap.data()?.userIds ?? [];
      const userIds =
        existing.includes(userId) ? existing : [...existing, userId];
      tx.set(ref, { provider, providerUserId, userIds });
    });
  }

  /**
   * Remove a user from a provider-account's reverse-index entry, deleting the
   * doc entirely once no user references it.
   */
  private async removeUserFromIndex(
    provider: HealthProviderId,
    providerUserId: string,
    userId: string,
  ): Promise<void> {
    await this.databaseService.runTransaction(async (collections, tx) => {
      const ref = collections.healthProviderUserIndex.doc(
        healthProviderUserIndexId(provider, providerUserId),
      );
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const remaining = (snap.data()?.userIds ?? []).filter(
        (id) => id !== userId,
      );
      if (remaining.length === 0) {
        tx.delete(ref);
      } else {
        tx.set(ref, { provider, providerUserId, userIds: remaining });
      }
    });
  }

  // Webhooks -----------------------------------------------------------------

  /**
   * Handle a raw inbound webhook for a provider: let the adapter run its
   * verification handshake / signature check, then ingest any changed windows.
   * Sends the HTTP response.
   */
  async handleWebhook(
    provider: HealthProviderId,
    req: Request,
    res: Response,
  ): Promise<void> {
    const adapter = this.resolveAdapter(provider);
    let handling: WebhookHandling;
    try {
      handling = adapter.handleWebhook(req, res);
    } catch (error) {
      logger.error(
        `HealthProviderService: ${provider} webhook parse/verify failed: ${String(error)}`,
      );
      res.status(400).send("invalid webhook");
      return;
    }

    if (handling.kind === "verification") {
      // Adapter already wrote the verification response.
      return;
    }

    // Acknowledge before the (possibly slow) fetch work so providers don't retry
    // on a timeout; individual failures are logged and retried by the backfill.
    res.status(204).send();

    for (const notification of handling.notifications) {
      try {
        await this.ingestNotification(provider, adapter, notification);
      } catch (error) {
        logger.error(
          `HealthProviderService: ${provider} webhook ingest failed for providerUserId=${notification.providerUserId}: ${String(error)}`,
        );
      }
    }
  }

  private async ingestNotification(
    provider: HealthProviderId,
    adapter: HealthProviderAdapter,
    notification: ProviderWebhookNotification,
  ): Promise<void> {
    const index = await this.databaseService.getDocument((collections) =>
      collections.healthProviderUserIndex.doc(
        healthProviderUserIndexId(provider, notification.providerUserId),
      ),
    );
    if (index === undefined) {
      logger.warn(
        `HealthProviderService: no user mapped to ${provider} providerUserId=${notification.providerUserId}`,
      );
      return;
    }

    // Clamp the window: `until` never runs past now, and `since` never reaches
    // further back than WEBHOOK_MAX_LOOKBACK_DAYS — the notification's timestamps
    // are caller-controlled and must not drive an unbounded fetch.
    const now = new Date();
    const until = new Date(
      Math.min((notification.until ?? now).getTime(), now.getTime()),
    );
    const earliest = daysAgo(WEBHOOK_MAX_LOOKBACK_DAYS);
    const requestedSince = notification.since ?? daysAgo(2);
    const since = new Date(
      Math.max(requestedSince.getTime(), earliest.getTime()),
    );

    // A shared provider account may map to more than one MHC user.
    for (const userId of index.content.userIds) {
      await this.ingest(userId, provider, adapter, since, until);
    }
  }

  // Backfill / polling -------------------------------------------------------

  /**
   * Iterate every stored connection for a provider and pull anything since the
   * connection's `lastSyncAt`. Used by the daily scheduled backfill.
   */
  async backfillProvider(provider: HealthProviderId): Promise<void> {
    const adapter = this.resolveAdapter(provider);
    const tokenDocs = await this.databaseService.getQuery((collections) =>
      collections.firestore
        .collectionGroup("healthProviderTokens")
        .where("provider", "==", provider),
    );

    for (const tokenDoc of tokenDocs) {
      // path: users/{userId}/healthProviderTokens/{provider}
      const userId = tokenDoc.path.split("/")[1];
      if (!userId) continue;
      try {
        const connection = await this.databaseService.getDocument(
          (collections) =>
            collections.healthProviderConnections(userId).doc(provider),
        );
        const since = connection?.content.lastSyncAt ?? daysAgo(2);
        await this.ingest(userId, provider, adapter, since, new Date());
      } catch (error) {
        logger.error(
          `HealthProviderService: backfill failed for ${provider}/${userId}: ${String(error)}`,
        );
      }
    }
  }

  // Ingestion ----------------------------------------------------------------

  private async ingest(
    userId: string,
    provider: HealthProviderId,
    adapter: HealthProviderAdapter,
    since: Date,
    until: Date,
  ): Promise<void> {
    try {
      const tokens = await this.validAccessToken(userId, provider, adapter);
      const observations = await adapter.fetchObservations({
        tokens,
        since,
        until,
        subject: this.subject(userId),
      });
      await this.writeObservations(userId, provider, observations);
      await this.markSync(userId, provider, HealthProviderSyncStatus.ok, until);
    } catch (error) {
      // Only a credential failure (unrenewable/rejected token) flips the
      // client-visible connection status to `error`; a transient fetch failure
      // records the error but leaves the connection `connected` so a single blip
      // doesn't show the wearable as broken until the next sync.
      await this.markSync(
        userId,
        provider,
        HealthProviderSyncStatus.error,
        undefined,
        String(error),
        isAuthFailure(error),
      );
      throw error;
    }
  }

  private async writeObservations(
    userId: string,
    provider: HealthProviderId,
    observations: ProviderObservation[],
  ): Promise<void> {
    if (observations.length === 0) return;
    // BulkWriter batches and throttles the fan-out for us. The per-op promises
    // can't be awaited inside the callback (the wrapper closes the writer only
    // afterwards), so we buffer the sets and await a flush to confirm completion.
    await this.databaseService.bulkWrite(async (collections, writer) => {
      for (const { metric, observation } of observations) {
        if (observation.id === undefined) continue;
        const ref = collections
          .userHealthObservations(
            userId,
            providerObservationCollectionName(provider, metric),
          )
          .doc(observation.id);
        void writer.set(ref, observation);
      }
      await writer.flush();
    });
  }

  // Tokens -------------------------------------------------------------------

  private async storeTokens(
    userId: string,
    provider: HealthProviderId,
    tokens: ProviderTokens,
    subscriptionId?: string,
  ): Promise<void> {
    await this.databaseService.setDocument(
      (collections) => collections.healthProviderTokens(userId).doc(provider),
      {
        provider,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        providerUserId: tokens.providerUserId,
        updatedAt: new Date(),
        subscriptionId,
      },
    );
  }

  /**
   * Return a non-expired access token, transparently refreshing and persisting
   * rotated tokens (Fitbit and Withings rotate their refresh tokens).
   */
  private async validAccessToken(
    userId: string,
    provider: HealthProviderId,
    adapter: HealthProviderAdapter,
  ): Promise<ProviderTokens> {
    const tokenDoc = await this.databaseService.getDocument((collections) =>
      collections.healthProviderTokens(userId).doc(provider),
    );
    if (tokenDoc === undefined) {
      throw new Error(`No stored tokens for ${provider}/${userId}.`);
    }

    const stored: ProviderTokens = tokenDoc.content;
    if (stored.expiresAt.getTime() > Date.now() + TOKEN_EXPIRY_SKEW_MS) {
      return stored;
    }

    let refreshed: ProviderTokens;
    try {
      refreshed = await adapter.refreshTokens(stored.refreshToken);
    } catch (error) {
      // A failed refresh means the stored credentials can no longer be renewed;
      // surface it as an auth failure so the connection status flips to `error`.
      throw new ProviderAuthError(`${provider} token refresh`, error);
    }
    // Preserve providerUserId if the refresh response omits it.
    const merged: ProviderTokens = {
      ...refreshed,
      providerUserId: refreshed.providerUserId || stored.providerUserId,
      scopes: refreshed.scopes.length > 0 ? refreshed.scopes : stored.scopes,
    };

    // Compare-and-set: persist only if no concurrent sync already rotated the
    // refresh token (Fitbit/Withings invalidate the old one on first use). If
    // another writer got there first, keep its tokens rather than clobbering
    // them with a now-stale value.
    return this.databaseService.runTransaction(async (collections, tx) => {
      const ref = collections.healthProviderTokens(userId).doc(provider);
      const snap = await tx.get(ref);
      const current = snap.data();
      if (
        current !== undefined &&
        current.refreshToken !== stored.refreshToken
      ) {
        return current;
      }
      tx.set(ref, {
        provider,
        accessToken: merged.accessToken,
        refreshToken: merged.refreshToken,
        expiresAt: merged.expiresAt,
        scopes: merged.scopes,
        providerUserId: merged.providerUserId,
        updatedAt: new Date(),
        subscriptionId:
          current?.subscriptionId ?? tokenDoc.content.subscriptionId,
      });
      return merged;
    });
  }

  private async markSync(
    userId: string,
    provider: HealthProviderId,
    status: HealthProviderSyncStatus,
    lastSyncAt?: Date,
    lastError?: string,
    markConnectionError = false,
  ): Promise<void> {
    const data: Record<string, unknown> = {
      provider,
      lastSyncStatus: status,
    };
    // Only touch the client-visible connection `status` on success (→ connected)
    // or a credential failure (→ error). A transient sync failure leaves the
    // existing status untouched so the wearable isn't shown as broken over a blip.
    if (status === HealthProviderSyncStatus.ok) {
      data.status = HealthProviderConnectionStatus.connected;
    } else if (markConnectionError) {
      data.status = HealthProviderConnectionStatus.error;
    }
    if (lastSyncAt) data.lastSyncAt = Timestamp.fromDate(lastSyncAt);
    if (lastError) data.lastError = lastError;

    // Partial merge onto a converter-free reference so we don't clobber
    // scopes/connectedAt written at connection time (the converter always
    // encodes the full document, which would defeat a merge).
    await this.databaseService.setDocument(
      (collections) =>
        collections.firestore
          .collection("users")
          .doc(userId)
          .collection("healthProviderConnections")
          .doc(provider),
      data,
      { merge: true },
    );
  }
}
