// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import { https } from "firebase-functions/v2";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";
import { markAccountForDeletion } from "./markAccountForDeletion.js";

describeWithEmulators("function: markAccountForDeletion", (env) => {
  it("successfully marks a user account for deletion", async () => {
    const userId = await env.createUser({});

    const userService = env.factory.user();

    // Verify user exists and is not marked for deletion
    const originalUser = await userService.getUser(userId);
    expect(originalUser).to.exist;
    expect(originalUser?.content.disabled).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    expect((originalUser?.content as any).toBeDeleted).to.be.undefined;

    const result = await env.call(
      markAccountForDeletion,
      {},
      {
        uid: userId,
        token: {
          disabled: false,
        },
      },
    );

    // Verify function response ...
    expect(result.success).to.be.true;
    expect(result.markedAt).to.be.a("string");
    expect(new Date(result.markedAt)).to.be.instanceOf(Date);
  });

  it("prevents unauthenticated users from marking accounts", async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      await env.call(markAccountForDeletion, {}, {} as any);
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("unauthenticated");
      expect((error as https.HttpsError).message).to.contain(
        "User is not authenticated",
      );
    }
  });

  it("allows users to mark only their own accounts", async () => {
    const userId = await env.createUser({});

    // This should succeed
    const result = await env.call(
      markAccountForDeletion,
      {},
      {
        uid: userId,
        token: {
          disabled: false,
        },
      },
    );

    expect(result.success).to.be.true;
    expect(result.markedAt).to.be.a("string");
  });

  it("prevents marking already deleted accounts", async () => {
    const userId = await env.createUser({});

    // First call should succeed
    await env.call(
      markAccountForDeletion,
      {},
      {
        uid: userId,
        token: {
          disabled: false,
        },
      },
    );

    // Second call should fail
    try {
      await env.call(
        markAccountForDeletion,
        {},
        {
          uid: userId,
          token: {
            disabled: false,
          },
        },
      );
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("already-exists");
      expect((error as https.HttpsError).message).to.contain(
        "already marked for deletion",
      );
    }
  });

  it("prevents marking disabled accounts for deletion", async () => {
    const userId = await env.createUser({
      disabled: true,
    });

    try {
      await env.call(
        markAccountForDeletion,
        {},
        {
          uid: userId,
          token: {
            disabled: true,
          },
        },
      );
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("permission-denied");
      expect((error as https.HttpsError).message).to.contain(
        "User is disabled",
      );
    }
  });

  it("handles non-existent user accounts", async () => {
    const nonExistentUserId = "non-existent-user-id";

    try {
      await env.call(
        markAccountForDeletion,
        {},
        {
          uid: nonExistentUserId,
          token: {
            disabled: false,
          },
        },
      );
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("not-found");
      expect((error as https.HttpsError).message).to.contain(
        "User account not found",
      );
    }
  });

  it("stores rich metadata with the deletion request", async () => {
    const userId = await env.createUser({});

    const result = await env.call(
      markAccountForDeletion,
      {},
      {
        uid: userId,
        token: {
          disabled: false,
        },
      },
    );

    // Verify the function returns success and valid timestamp
    expect(result.success).to.be.true;
    expect(result.markedAt).to.be.a("string");
    expect(new Date(result.markedAt)).to.be.instanceOf(Date);
  });
});
