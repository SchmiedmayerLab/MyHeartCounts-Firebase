// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHash, randomBytes } from "crypto";
import { type Bucket } from "@google-cloud/storage";
import { type Response } from "express";
import { type Firestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { type Request } from "firebase-functions/v2/https";
import { buildExchangeBundles } from "./grove/bundleBuilder.js";
import {
  archiveRawPayloads,
  uploadProviderBundles,
} from "./grove/bundleStorage.js";
import { type RecordDraft } from "./grove/drafts.js";
import { type GroveIdentityKey } from "./grove/identity.js";
import { loadGroveIdentityKey } from "./grove/identityConfig.js";
import {
  type HealthProviderAdapter,
  type ProviderWebhookNotification,
  type WebhookHandling,
} from "./healthProviderAdapter.js";
import {
  isProviderAuthFailure,
  ProviderAuthError,
  ProviderHttpError,
} from "./httpClient.js";
import { getAdapter } from "./providerRegistry.js";
import {
  getHealthProviderBaseUrl,
  getHealthProviderAppRedirectUrl,
} from "../../env.js";
import { getPackageVersion } from "../../helpers/packageVersion.js";
import {
  HealthProviderConnectionStatus,
  type HealthProviderId,
  HealthProviderSyncError,
  HealthProviderSyncStatus,
  healthProviderUserIndexId,
  type ProviderTokens,
} from "../../models/index.js";
import { type DatabaseService } from "../database/databaseService.js";

/** How far back the initial import reaches after a fresh connection. */
export const INITIAL_BACKFILL_DAYS = 30;
/** Minimum spacing between manual (`syncHealthProvider`) syncs. */
export const MANUAL_SYNC_THROTTLE_MS = 15 * 60 * 1000;
/** OAuth state lifetime. */
const AUTH_REQUEST_TTL_MS = 15 * 60 * 1000;
/** Refresh access tokens this long before their nominal expiry. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/**
 * Upper bound on how far back a webhook-triggered fetch may reach. Webhook
 * bodies (notably Withings Notify) carry a caller-supplied `startdate` with no
 * per-request signature, so the window is clamped here to prevent a forged
 * notification from forcing an unbounded backfill on a victim's token. Deeper
 * history is covered by the scheduled backfill.
 */
const WEBHOOK_MAX_LOOKBACK_DAYS = 7;
/** Default window for a webhook without bounds, and after a missing lastSyncAt. */
const DEFAULT_LOOKBACK_DAYS = 2;

const daysAgo = (days: number, now = Date.now()): Date =>
  new Date(now - days * 24 * 60 * 60 * 1000);

const base64url = (buffer: Buffer): string =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Map an ingest failure to the sanitized client-facing error code. */
const syncErrorCode = (error: unknown): HealthProviderSyncError => {
  if (isProviderAuthFailure(error)) return HealthProviderSyncError.authFailed;
  if (error instanceof ProviderHttpError) {
    return HealthProviderSyncError.providerUnavailable;
  }
  return HealthProviderSyncError.unknown;
};

/** A connection attempt failed; `provider` is set whenever it is known. */
export class HealthProviderConnectionError extends Error {
  constructor(
    readonly reason: string,
    readonly provider?: HealthProviderId,
    cause?: unknown,
  ) {
    super(
      `${reason}${cause === undefined ? "" : `: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`}`,
    );
    this.name = "HealthProviderConnectionError";
    Object.setPrototypeOf(this, HealthProviderConnectionError.prototype);
  }
}

/** How one ingest relates to the connection's sync bookkeeping. */
interface IngestMode {
  /** Advance `lastSyncAt` to `until` when the window fully succeeds. */
  advancesLastSync: boolean;
  /** Mark the initial history import complete when the window fully succeeds. */
  completesInitialSync: boolean;
}

export class HealthProviderService {
  private readonly databaseService: DatabaseService;
  private readonly bucket: Bucket;
  private readonly resolveAdapter: (
    provider: HealthProviderId,
  ) => HealthProviderAdapter;
  private readonly identityKey: () => GroveIdentityKey;

  constructor(
    databaseService: DatabaseService,
    bucket: Bucket,
    // Injectable so tests can substitute a fake adapter and identity key.
    resolveAdapter: (
      provider: HealthProviderId,
    ) => HealthProviderAdapter = getAdapter,
    identityKey: () => GroveIdentityKey = loadGroveIdentityKey,
  ) {
    this.databaseService = databaseService;
    this.bucket = bucket;
    this.resolveAdapter = resolveAdapter;
    this.identityKey = identityKey;
  }

  // URLs ---------------------------------------------------------------------

  private get callbackUrl(): string {
    return `${getHealthProviderBaseUrl()}/healthProviderOAuthCallback`;
  }

  private webhookUrl(provider: HealthProviderId): string {
    return `${getHealthProviderBaseUrl()}/${provider}Webhook`;
  }

  /** App deep link for a successful connection. */
  static connectedRedirect(provider: HealthProviderId): string {
    return `${getHealthProviderAppRedirectUrl()}/${provider}/connected`;
  }

  /** App deep link for a failed connection (provider-scoped when known). */
  static errorRedirect(reason: string, provider?: HealthProviderId): string {
    const base = getHealthProviderAppRedirectUrl();
    const query = `reason=${encodeURIComponent(reason)}`;
    return provider ?
        `${base}/${provider}/error?${query}`
      : `${base}/error?${query}`;
  }

  private connectionRef(userId: string, provider: HealthProviderId) {
    // Converter-free reference: partial merges must not re-encode the document.
    return (collections: { firestore: Firestore }) =>
      collections.firestore
        .collection("users")
        .doc(userId)
        .collection("healthProviderConnections")
        .doc(provider);
  }

  // Connection lifecycle -----------------------------------------------------

  /**
   * Begin an OAuth connection: persist a one-time state record (carrying a PKCE
   * verifier where needed) and return the provider authorization URL the client
   * opens for consent. `expiresAt` is also the Firestore TTL field.
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
        expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
      },
    );

    return adapter.buildAuthorizationUrl({ state, redirectUri, codeChallenge });
  }

  /**
   * Atomically read and delete the auth request for `state`, so a replayed or
   * concurrent callback can never consume it twice.
   */
  private async consumeAuthRequest(state: string) {
    return this.databaseService.runTransaction(async (collections, tx) => {
      const ref = collections.healthProviderAuthRequests.doc(state);
      const snap = await tx.get(ref);
      const content = snap.data();
      if (content !== undefined) tx.delete(ref);
      return content;
    });
  }

  /**
   * Abort a pending connection after a provider-reported error. Consumes the
   * state (if valid) and returns the provider it was for.
   */
  async abandonConnection(
    state: string | undefined,
  ): Promise<HealthProviderId | undefined> {
    if (!state) return undefined;
    try {
      return (await this.consumeAuthRequest(state))?.provider;
    } catch (error) {
      logger.warn(
        `HealthProviderService: could not consume abandoned state: ${String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Complete an OAuth connection from the provider's redirect: consume the
   * state record, exchange the code, persist tokens, register the webhook
   * subscription and reverse-lookup index, and mark the connection connected
   * (which starts the initial history import via the connection trigger).
   * Returns the app deep link the callback should redirect the browser to.
   * Throws {@link HealthProviderConnectionError}.
   */
  async completeConnection(state: string, code: string): Promise<string> {
    const authRequest = await this.consumeAuthRequest(state);
    if (authRequest === undefined) {
      throw new HealthProviderConnectionError("invalid_state");
    }
    const { provider, userId, redirectUri, codeVerifier, expiresAt } =
      authRequest;
    if (expiresAt.getTime() < Date.now()) {
      throw new HealthProviderConnectionError("state_expired", provider);
    }
    const adapter = this.resolveAdapter(provider);

    let tokens: ProviderTokens;
    try {
      tokens = await adapter.exchangeCode({ code, redirectUri, codeVerifier });
    } catch (error) {
      throw new HealthProviderConnectionError(
        "token_exchange_failed",
        provider,
        error,
      );
    }

    let subscriptionId: string | undefined;
    try {
      const result = await adapter.ensureSubscription({
        tokens,
        callbackUrl: this.webhookUrl(provider),
      });
      subscriptionId = result.subscriptionId;
    } catch (error) {
      // A missing subscription degrades to scheduled polling only.
      logger.error(
        `HealthProviderService: ensureSubscription failed for ${provider}/${userId}: ${String(error)}`,
      );
    }

    try {
      await this.storeTokens(userId, provider, tokens, subscriptionId);
      await this.addUserToIndex(provider, tokens.providerUserId, userId);
      await this.databaseService.setDocument(
        (collections) =>
          collections.healthProviderConnections(userId).doc(provider),
        {
          provider,
          status: HealthProviderConnectionStatus.connected,
          scopes: tokens.scopes,
          connectedAt: new Date(),
          lastSyncAt: undefined,
          lastSyncAttemptAt: undefined,
          initialSyncCompletedAt: undefined,
          lastSyncStatus: undefined,
          lastError: undefined,
        },
      );
    } catch (error) {
      throw new HealthProviderConnectionError(
        "storage_failed",
        provider,
        error,
      );
    }

    return HealthProviderService.connectedRedirect(provider);
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
          lastSyncAttemptAt: undefined,
          initialSyncCompletedAt: undefined,
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
      // Adapter already wrote the response.
      return;
    }

    // Acknowledge before the (possibly slow) fetch work so providers don't retry
    // on a timeout; failures are recorded on the connection document and the
    // window is covered again by the scheduled backfill.
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
    const requestedSince = notification.since ?? daysAgo(DEFAULT_LOOKBACK_DAYS);
    const since = new Date(
      Math.max(requestedSince.getTime(), earliest.getTime()),
    );

    // A shared provider account may map to more than one MHC user. A webhook
    // window is partial by nature, so it never advances `lastSyncAt` or
    // completes the initial import — those stay owned by full-window syncs.
    for (const userId of index.content.userIds) {
      try {
        await this.ingest(userId, provider, adapter, since, until, {
          advancesLastSync: false,
          completesInitialSync: false,
        });
      } catch (error) {
        logger.error(
          `HealthProviderService: webhook ingest failed for ${provider}/${userId}: ${String(error)}`,
        );
      }
    }
  }

  // Full-window syncs --------------------------------------------------------

  /**
   * Sync one connection from its `lastSyncAt` (or, until the initial import
   * has fully succeeded, from INITIAL_BACKFILL_DAYS ago) up to now. Skipped for
   * disconnected or unknown connections.
   */
  async syncConnection(
    userId: string,
    provider: HealthProviderId,
  ): Promise<void> {
    const connection = await this.databaseService.getDocument((collections) =>
      collections.healthProviderConnections(userId).doc(provider),
    );
    if (
      connection === undefined ||
      connection.content.status === HealthProviderConnectionStatus.disconnected
    ) {
      return;
    }
    const initialPending =
      connection.content.initialSyncCompletedAt === undefined;
    const since =
      initialPending ?
        daysAgo(INITIAL_BACKFILL_DAYS)
      : (connection.content.lastSyncAt ?? daysAgo(DEFAULT_LOOKBACK_DAYS));
    await this.ingest(
      userId,
      provider,
      this.resolveAdapter(provider),
      since,
      new Date(),
      { advancesLastSync: true, completesInitialSync: initialPending },
    );
  }

  /**
   * Run the initial history import for a freshly connected provider (called
   * by the connection-document trigger).
   */
  async runInitialSync(
    userId: string,
    provider: HealthProviderId,
  ): Promise<void> {
    await this.syncConnection(userId, provider);
  }

  /**
   * Manual sync requested by the app. Throttled to one attempt per
   * MANUAL_SYNC_THROTTLE_MS per connection (by `lastSyncAttemptAt`, checked
   * and reserved atomically).
   */
  async requestSync(
    userId: string,
    provider: HealthProviderId,
  ): Promise<"started" | "throttled" | "not_connected"> {
    const reserved = await this.databaseService.runTransaction(
      async (collections, tx) => {
        const ref = this.connectionRef(userId, provider)(collections);
        const snap = await tx.get(ref);
        const data = snap.data();
        if (
          data === undefined ||
          data.status === HealthProviderConnectionStatus.disconnected
        ) {
          return "not_connected" as const;
        }
        const last = (
          data.lastSyncAttemptAt as Timestamp | null | undefined
        )?.toMillis();
        if (last !== undefined && Date.now() - last < MANUAL_SYNC_THROTTLE_MS) {
          return "throttled" as const;
        }
        tx.set(ref, { lastSyncAttemptAt: Timestamp.now() }, { merge: true });
        return "started" as const;
      },
    );
    if (reserved !== "started") return reserved;
    try {
      await this.syncConnection(userId, provider);
    } catch (error) {
      // Recorded on the connection document; the call itself succeeded.
      logger.warn(
        `HealthProviderService: manual sync failed for ${provider}/${userId}: ${String(error)}`,
      );
    }
    return "started";
  }

  /**
   * Iterate every stored connection for a provider and sync it. Used by the
   * daily scheduled backfill.
   */
  async backfillProvider(provider: HealthProviderId): Promise<void> {
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
        await this.syncConnection(userId, provider);
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
    mode: IngestMode,
  ): Promise<void> {
    if (!(await this.markAttempt(userId, provider))) {
      // Disconnected (or never connected) in the meantime: nothing to do.
      return;
    }
    try {
      const tokens = await this.validAccessToken(userId, provider, adapter);
      const result = await adapter.fetchData({ tokens, since, until });
      const recordings = await archiveRawPayloads({
        bucket: this.bucket,
        userId,
        provider,
        archives: result.rawArchives,
        since,
        until,
      });
      const records: RecordDraft[] = [...result.records, ...recordings];
      if (records.length > 0) {
        const now = new Date();
        const bundles = buildExchangeBundles({
          provider,
          userId,
          providerUserId: tokens.providerUserId,
          key: this.identityKey(),
          records,
          recordedAt: now,
          packedAt: now,
          applicationVersion: getPackageVersion(),
        });
        await uploadProviderBundles({
          bucket: this.bucket,
          userId,
          provider,
          bundles,
        });
      }

      if (result.failures.length > 0) {
        logger.warn(
          `HealthProviderService: partial sync for ${provider}/${userId}; failed: ${result.failures.join(", ")}`,
        );
        await this.markSync(userId, provider, {
          status: HealthProviderSyncStatus.error,
          error:
            records.length === 0 ?
              HealthProviderSyncError.providerUnavailable
            : HealthProviderSyncError.partialFailure,
        });
        return;
      }
      await this.markSync(userId, provider, {
        status: HealthProviderSyncStatus.ok,
        lastSyncAt: mode.advancesLastSync ? until : undefined,
        initialSyncCompleted: mode.completesInitialSync,
      });
    } catch (error) {
      logger.error(
        `HealthProviderService: ingest failed for ${provider}/${userId}: ${String(error)}`,
      );
      await this.markSync(userId, provider, {
        status: HealthProviderSyncStatus.error,
        error: syncErrorCode(error),
      });
      throw error;
    }
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
   * rotated tokens (Withings rotates its refresh tokens).
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
      throw new ProviderAuthError(
        `${provider} tokens`,
        new Error(`No stored tokens for ${provider}/${userId}.`),
      );
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
    const merged: ProviderTokens = {
      ...refreshed,
      providerUserId: refreshed.providerUserId || stored.providerUserId,
      scopes: refreshed.scopes.length > 0 ? refreshed.scopes : stored.scopes,
    };

    // Compare-and-set: persist only if no concurrent sync already rotated the
    // refresh token (Withings invalidates the old one on first use).
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

  // Status bookkeeping ------------------------------------------------------

  /** Record a sync attempt; false when the connection is gone/disconnected. */
  private async markAttempt(
    userId: string,
    provider: HealthProviderId,
  ): Promise<boolean> {
    return this.databaseService.runTransaction(async (collections, tx) => {
      const ref = this.connectionRef(userId, provider)(collections);
      const snap = await tx.get(ref);
      const data = snap.data();
      if (
        data === undefined ||
        data.status === HealthProviderConnectionStatus.disconnected
      ) {
        return false;
      }
      tx.set(ref, { lastSyncAttemptAt: Timestamp.now() }, { merge: true });
      return true;
    });
  }

  /**
   * Merge a sync outcome into the connection document. A no-op when the
   * connection was disconnected (or deleted) while the sync ran, so a late
   * sync never resurrects it. `lastSyncAt` only moves forward.
   */
  private async markSync(
    userId: string,
    provider: HealthProviderId,
    outcome: {
      status: HealthProviderSyncStatus;
      error?: HealthProviderSyncError;
      lastSyncAt?: Date;
      initialSyncCompleted?: boolean;
    },
  ): Promise<void> {
    try {
      await this.databaseService.runTransaction(async (collections, tx) => {
        const ref = this.connectionRef(userId, provider)(collections);
        const snap = await tx.get(ref);
        const current = snap.data();
        if (
          current === undefined ||
          current.status === HealthProviderConnectionStatus.disconnected
        ) {
          return;
        }
        const data: Record<string, unknown> = {
          lastSyncStatus: outcome.status,
          lastError: outcome.error ?? null,
        };
        if (outcome.status === HealthProviderSyncStatus.ok) {
          data.status = HealthProviderConnectionStatus.connected;
        } else if (outcome.error === HealthProviderSyncError.authFailed) {
          data.status = HealthProviderConnectionStatus.error;
        }
        if (outcome.lastSyncAt !== undefined) {
          const previous = (
            current.lastSyncAt as Timestamp | null | undefined
          )?.toMillis();
          if (
            previous === undefined ||
            previous < outcome.lastSyncAt.getTime()
          ) {
            data.lastSyncAt = Timestamp.fromDate(outcome.lastSyncAt);
          }
        }
        if (
          outcome.initialSyncCompleted === true &&
          (current.initialSyncCompletedAt ?? null) === null
        ) {
          data.initialSyncCompletedAt = Timestamp.now();
        }
        tx.set(ref, data, { merge: true });
      });
    } catch (error) {
      logger.error(
        `HealthProviderService: failed to record sync status for ${provider}/${userId}: ${String(error)}`,
      );
    }
  }
}
