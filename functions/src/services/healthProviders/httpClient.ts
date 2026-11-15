// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Thin wrappers over the built-in global `fetch` (undici on Node 22) shared by
 * all provider adapters. No third-party HTTP dependency is required.
 */

import { logger } from "firebase-functions/v2";

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, context: string) {
    super(`${context} failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
    // Restore the prototype chain: the es5 compile target down-levels `Error`
    // subclasses in a way that otherwise breaks `instanceof` and prototype
    // getters (see the `isAuthFailure` getter below).
    Object.setPrototypeOf(this, ProviderHttpError.prototype);
  }

  /**
   * Whether the status indicates the credentials are no longer usable. Only
   * 401/403: a 400 on a data endpoint is a request problem (e.g. a malformed
   * filter), not a revoked token. Token-endpoint failures (where 400
   * `invalid_grant` does mean revoked) are wrapped in {@link ProviderAuthError}
   * by the token refresh path instead.
   */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Raised when a token refresh fails, signalling that the stored credentials can
 * no longer be renewed (revoked/expired refresh token). The orchestrator uses
 * this to flip the connection status to `error` — unlike a transient data-fetch
 * failure, which leaves the connection `connected`.
 */
export class ProviderAuthError extends Error {
  constructor(
    context: string,
    readonly cause: unknown,
  ) {
    super(`${context}: ${String(cause)}`);
    this.name = "ProviderAuthError";
    Object.setPrototypeOf(this, ProviderAuthError.prototype);
  }
}

const parseJson = async <T>(
  response: Response,
  context: string,
): Promise<T> => {
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderHttpError(response.status, text, context);
  }
  if (text.length === 0) {
    return undefined as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `${context}: failed to parse JSON response: ${String(error)}`,
    );
  }
};

/** GET a JSON resource with a bearer token. */
export const getJson = async <T>(
  url: string,
  accessToken: string,
  context: string,
  extraHeaders?: Record<string, string>,
): Promise<T> => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(extraHeaders ?? {}),
    },
  });
  return parseJson<T>(response, context);
};

/** POST a request and parse a JSON response. */
export const postJson = async <T>(
  url: string,
  init: {
    body: URLSearchParams | string;
    headers?: Record<string, string>;
  },
  context: string,
): Promise<T> => {
  const isForm = init.body instanceof URLSearchParams;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":
        isForm ? "application/x-www-form-urlencoded" : "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
  return parseJson<T>(response, context);
};

/** Whether an error means the stored credentials are unusable. */
export const isProviderAuthFailure = (error: unknown): boolean =>
  error instanceof ProviderAuthError ||
  (error instanceof ProviderHttpError && error.isAuthFailure);

/**
 * Await one per-endpoint request, isolating transient failures: a 429/5xx (or
 * any non-auth error) is logged and resolves to `undefined` so the surrounding
 * `Promise.all` still yields the endpoints that did succeed. Auth failures are
 * rethrown so the caller can mark the connection as broken.
 *
 * Pass a `failures` array to record which endpoints failed: the orchestrator
 * treats any recorded failure as a partial sync and does not advance
 * `lastSyncAt`, so the next sync re-fetches the window.
 */
export const settleEndpoint = async <T>(
  context: string,
  promise: Promise<T>,
  failures?: string[],
): Promise<T | undefined> => {
  try {
    return await promise;
  } catch (error) {
    if (isProviderAuthFailure(error)) {
      throw error;
    }
    logger.warn(
      `${context}: fetch failed, window will be retried: ${String(error)}`,
    );
    failures?.push(context);
    return undefined;
  }
};

/** Basic-auth header value for `client_id:client_secret`. */
export const basicAuthHeader = (
  clientId: string,
  clientSecret: string,
): string =>
  `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
