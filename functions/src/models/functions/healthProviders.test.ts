// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { healthProviderOAuthCallbackQuerySchema } from "./healthProviders.js";

describe("healthProviderOAuthCallbackQuerySchema", () => {
  it("extracts string code/state/error", () => {
    const result = healthProviderOAuthCallbackQuerySchema.parse({
      code: "the-code",
      state: "the-state",
    });
    expect(result.code).to.equal("the-code");
    expect(result.state).to.equal("the-state");
    expect(result.error).to.equal(undefined);
  });

  it("drops non-string (array) query values to undefined", () => {
    const result = healthProviderOAuthCallbackQuerySchema.parse({
      code: ["a", "b"],
      state: 5,
      error: "access_denied",
    });
    expect(result.code).to.equal(undefined);
    expect(result.state).to.equal(undefined);
    expect(result.error).to.equal("access_denied");
  });

  it("accepts an empty query", () => {
    const result = healthProviderOAuthCallbackQuerySchema.parse({});
    expect(result.code).to.equal(undefined);
    expect(result.state).to.equal(undefined);
    expect(result.error).to.equal(undefined);
  });
});
