// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { it } from "mocha";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";
import { updateUserInformation } from "./updateUserInformation.js";

describeWithEmulators("function: updateUserInformation", (env) => {
  it("updates user information successfully", async () => {
    const authUser = await env.auth.createUser({});

    await env.call(
      updateUserInformation,
      {
        userId: authUser.uid,
        data: {
          auth: {
            displayName: "Test User",
          },
        },
      },
      { uid: authUser.uid },
    );

    const updatedUser = await env.auth.getUser(authUser.uid);
    expect(updatedUser.displayName).to.equal("Test User");
  });
});
