// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import type { https } from "firebase-functions/v2";
import { it } from "mocha";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";
import { expectError } from "../tests/helpers.js";
import { markAccountForStudyWithdrawal } from "./markAccountForStudyWithdrawal.js";

describeWithEmulators("function: markAccountForStudyWithdrawal", (env) => {
  it("marks user for study withdrawal successfully", async () => {
    const userId = await env.createUser({});

    const result = await env.call(
      markAccountForStudyWithdrawal,
      {},
      { uid: userId },
    );

    expect(result.success).to.equal(true);
    expect(result.withdrawnAt).to.be.a("string");
    const withdrawnTime = new Date(result.withdrawnAt).getTime();
    expect(withdrawnTime).to.be.lessThanOrEqual(Date.now());
  });

  it("throws error when user account not found", async () => {
    const authUser = await env.auth.createUser({});

    await expectError(
      () => env.call(markAccountForStudyWithdrawal, {}, { uid: authUser.uid }),
      (error) => {
        const httpsError = error as https.HttpsError;
        expect(httpsError.code).to.equal("not-found");
      },
    );
  });

  it("throws error when user account is disabled", async () => {
    const userId = await env.createUser({ disabled: true });

    await expectError(
      () => env.call(markAccountForStudyWithdrawal, {}, { uid: userId }),
      (error) => {
        const httpsError = error as https.HttpsError;
        expect(httpsError.code).to.equal("failed-precondition");
      },
    );
  });
});
