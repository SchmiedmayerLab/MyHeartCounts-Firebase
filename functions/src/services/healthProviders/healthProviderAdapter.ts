// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type Response } from "express";
import { type Request } from "firebase-functions/v2/https";
import {
  type FHIRObservation,
  type FHIRReference,
  type HealthProviderId,
  type ProviderTokens,
} from "../../models/index.js";

/**
 * A normalized observation together with the metric slug that selects its
 * destination collection (`{Provider}Observations_{metric}`). The metric suffix
 * must be alphanumeric to satisfy the deletion-queue collection pattern.
 */
export interface ProviderObservation {
  metric: string;
  observation: FHIRObservation;
}

/**
 * A single unit of "something changed for this provider user" extracted from a
 * webhook payload. The orchestrator maps `providerUserId` to our Firebase uid
 * and then pulls the affected window via {@link HealthProviderAdapter.fetchObservations}.
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

export interface FetchObservationsParams {
  tokens: ProviderTokens;
  since: Date;
  until: Date;
  /** FHIR subject reference to stamp on every produced observation. */
  subject: FHIRReference;
}

/**
 * Per-provider integration surface. Everything provider-specific — OAuth
 * dialect, token lifetime, webhook signature/handshake, API schema and its
 * mapping to FHIR — is confined to an implementation of this interface. The
 * shared orchestration (token storage/refresh, routing, batched writes, status
 * bookkeeping) lives in {@link HealthProviderService} and is written once.
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

  /** Pull and normalize all supported observations in `[since, until]`. */
  fetchObservations(
    params: FetchObservationsParams,
  ): Promise<ProviderObservation[]>;
}
