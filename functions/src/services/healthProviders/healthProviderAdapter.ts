// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Response } from "express";
import { type Request } from "firebase-functions/v2/https";
import { type ObservationRecordDraft } from "./grove/drafts.js";
import {
  type HealthProviderId,
  type ProviderTokens,
} from "../../models/index.js";

/**
 * A single unit of "something changed for this provider user" extracted from a
 * webhook payload. The orchestrator maps `providerUserId` to our Firebase uid
 * and then pulls the affected window via {@link HealthProviderAdapter.fetchData}.
 */
export interface ProviderWebhookNotification {
  providerUserId: string;
  /** Optional lower bound of the changed window (provider-supplied). */
  since?: Date;
  /** Optional upper bound of the changed window (provider-supplied). */
  until?: Date;
}

/**
 * Result of handing a raw webhook request to an adapter.
 * - `verification`: the adapter recognized a subscription-verification handshake
 *   and has already written the correct response to `res`. The caller must not
 *   touch `res` further.
 * - `notifications`: real data-change events to ingest. The caller is
 *   responsible for sending the HTTP response (usually 200/204).
 */
export type WebhookHandling =
  | { kind: "verification" }
  | { kind: "notifications"; notifications: ProviderWebhookNotification[] };

export interface FetchDataParams {
  tokens: ProviderTokens;
  since: Date;
  until: Date;
}

/**
 * A provider payload kept verbatim (high-frequency series, or measure types
 * with no Grove profile). It is stored zstd-compressed in Cloud Storage and
 * described in the exchange Bundle by a `providers-recording-document`.
 */
export interface ProviderRawArchive {
  /** Bare provider source-type token (e.g. Oura `heartrate`). */
  sourceType: string;
  /** Alphanumeric slug used in the archive's Storage file name. */
  dataType: string;
  /** `DocumentReference.type.text`. */
  typeText: string;
  payload: unknown;
}

export interface ProviderFetchResult {
  /** Normalized source records (Grove drafts), one per provider record. */
  records: ObservationRecordDraft[];
  rawArchives: ProviderRawArchive[];
  /**
   * Contexts of endpoints that failed transiently. Any entry makes the sync
   * partial: data that did arrive is still stored, but `lastSyncAt` does not
   * advance so the window is fetched again.
   */
  failures: string[];
}

/**
 * Per-provider integration surface. Everything provider-specific — OAuth
 * dialect, token lifetime, webhook signature/handshake, API schema and its
 * mapping to Grove drafts — is confined to an implementation of this
 * interface. The shared orchestration (token storage/refresh, routing, Bundle
 * building/upload, status bookkeeping) lives in {@link HealthProviderService}.
 */
export interface HealthProviderAdapter {
  readonly id: HealthProviderId;
  /** OAuth scopes requested at authorization time. */
  readonly scopes: string[];

  /** Build the provider's authorization URL the client opens for consent. */
  buildAuthorizationUrl(params: {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
  }): string;

  /** Whether this provider uses PKCE (server generates a verifier/challenge). */
  readonly usesPkce: boolean;

  /** Exchange an authorization code for tokens. */
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<ProviderTokens>;

  /** Obtain fresh tokens from a (possibly rotating) refresh token. */
  refreshTokens(refreshToken: string): Promise<ProviderTokens>;

  /** Best-effort revocation of the connection at the provider. */
  revoke(tokens: ProviderTokens): Promise<void>;

  /** Create or renew the provider's webhook subscription for this user. */
  ensureSubscription(params: {
    tokens: ProviderTokens;
    callbackUrl: string;
  }): Promise<{ subscriptionId?: string }>;

  /** Remove the provider's webhook subscription for this user. */
  removeSubscription(params: {
    tokens: ProviderTokens;
    subscriptionId?: string;
    /** The callback URL that was subscribed (required by Withings `revoke`). */
    callbackUrl?: string;
  }): Promise<void>;

  /**
   * Inspect a raw inbound webhook request. Adapters own their verification
   * handshake and signature checks. Synchronous parsing only; the caller does
   * the follow-up data fetch.
   */
  handleWebhook(req: Request, res: Response): WebhookHandling;

  /** Pull everything in `[since, until]`: normalized records and raw archives. */
  fetchData(params: FetchDataParams): Promise<ProviderFetchResult>;
}
