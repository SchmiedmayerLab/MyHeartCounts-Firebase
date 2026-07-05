// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Thin wrappers over the built-in global `fetch` (undici on Node 22) shared by
 * all provider adapters. No third-party HTTP dependency is required.
 */

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, context: string) {
    super(`${context} failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
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
): Promise<T> => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
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

/** Basic-auth header value for `client_id:client_secret`. */
export const basicAuthHeader = (
  clientId: string,
  clientSecret: string,
): string =>
  `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
