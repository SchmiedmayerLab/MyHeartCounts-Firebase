// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import {
  ProviderAuthError,
  ProviderHttpError,
  settleEndpoint,
} from "./httpClient.js";

describe("httpClient: ProviderHttpError", () => {
  it("flags 400/401/403 as auth failures and others as transient", () => {
    expect(new ProviderHttpError(400, "", "ctx").isAuthFailure).to.equal(true);
    expect(new ProviderHttpError(401, "", "ctx").isAuthFailure).to.equal(true);
    expect(new ProviderHttpError(403, "", "ctx").isAuthFailure).to.equal(true);
    expect(new ProviderHttpError(429, "", "ctx").isAuthFailure).to.equal(false);
    expect(new ProviderHttpError(500, "", "ctx").isAuthFailure).to.equal(false);
  });

  it("truncates the body in the message", () => {
    const error = new ProviderHttpError(500, "x".repeat(1000), "ctx");
    expect(error.message.length).to.be.lessThan(600);
    expect(error.status).to.equal(500);
  });
});

describe("httpClient: ProviderAuthError", () => {
  it("wraps the underlying cause", () => {
    const cause = new Error("invalid_grant");
    const error = new ProviderAuthError("refresh", cause);
    expect(error.name).to.equal("ProviderAuthError");
    expect(error.cause).to.equal(cause);
    expect(error.message).to.contain("invalid_grant");
  });
});

describe("httpClient: settleEndpoint", () => {
  it("returns the resolved value on success", async () => {
    const value = await settleEndpoint("ctx", Promise.resolve([1, 2, 3]));
    expect(value).to.deep.equal([1, 2, 3]);
  });

  it("swallows a transient HTTP error and returns undefined", async () => {
    const value = await settleEndpoint(
      "ctx",
      Promise.reject<number[]>(new ProviderHttpError(429, "slow down", "ctx")),
    );
    expect(value).to.equal(undefined);
  });

  it("swallows a generic (non-HTTP) error and returns undefined", async () => {
    const value = await settleEndpoint(
      "ctx",
      Promise.reject<number[]>(new Error("boom")),
    );
    expect(value).to.equal(undefined);
  });

  it("rethrows an auth HTTP error so the caller can surface it", async () => {
    let thrown: unknown;
    try {
      await settleEndpoint(
        "ctx",
        Promise.reject(new ProviderHttpError(401, "unauthorized", "ctx")),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(ProviderHttpError);
    expect((thrown as ProviderHttpError).status).to.equal(401);
  });
});
