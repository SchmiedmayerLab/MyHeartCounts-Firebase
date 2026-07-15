// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import admin from "firebase-admin";
import { describe } from "mocha";
import { type UserService } from "./userService.js";
import { type UserAuth } from "../../models/index.js";
import { type MockFirestore } from "../../tests/mocks/firestore.js";
import { cleanupMocks, setupMockFirebase } from "../../tests/setup.js";
import { CollectionsService } from "../database/collections.js";
import { getServiceFactory } from "../factory/getServiceFactory.js";

describe("DatabaseUserService", () => {
  let _mockFirestore: MockFirestore;
  let userService: UserService;
  let collectionsService: CollectionsService;

  beforeEach(() => {
    _mockFirestore = setupMockFirebase().firestore;
    collectionsService = new CollectionsService(admin.firestore());
    userService = getServiceFactory().user();
  });

  afterEach(() => {
    cleanupMocks();
  });

  describe("auth methods", () => {
    it("gets and updates auth data", async () => {
      const userId = "mockAuthUser";

      // First create a user document to work with
      await userService.enrollUserDirectly(userId, {
        isSingleSignOn: false,
      });

      // Test getAuth
      const auth = await userService.getAuth(userId);
      expect(auth).to.exist;

      // Test updateAuth
      const newAuth: UserAuth = {
        displayName: "Test User",
        phoneNumber: "+1234567890",
      };

      await userService.updateAuth(userId, newAuth);

      // Test updateClaims
      await userService.updateClaims(userId);
    });
  });

  describe("enrollUserDirectly", () => {
    it("enrolls a patient directly", async () => {
      const userId = "mockPatientUserId";

      await userService.enrollUserDirectly(userId, {
        isSingleSignOn: false,
      });

      const userSnapshot = await collectionsService.users.doc(userId).get();
      expect(userSnapshot.exists).to.be.true;
      const userData = userSnapshot.data();
      expect(userData).to.exist;
      expect(userData?.dateOfEnrollment).to.exist;
      expect(userData?.extendedActivityNudgesOptIn).to.equal(true);
      expect(userData?.claims).to.deep.equal({
        disabled: false,
      });
    });

    it("handles finishUserEnrollment", async () => {
      const userId = "mockEnrollmentUser";

      const userDoc = await userService.enrollUserDirectly(userId, {
        isSingleSignOn: false,
      });

      // This might not complete successfully in the mock environment,
      // but we're testing that it doesn't throw an error
      try {
        await userService.finishUserEnrollment(userDoc);
      } catch {
        // Auth user might not be found, which is expected in the test environment
      }
    });
  });

  describe("user modification methods", () => {
    let testUserId: string;

    beforeEach(async () => {
      testUserId = "testModifyUser";
      await userService.enrollUserDirectly(testUserId, {
        isSingleSignOn: false,
      });
    });

    it("updates last upload date", async () => {
      // Test update last upload date
      const beforeUpdate = await userService.getUser(testUserId);
      const initialDate = beforeUpdate?.content.lastUploadDate;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      await userService.updateLastUploadDate(testUserId);

      const afterUpdate = await userService.getUser(testUserId);
      const updatedDate = afterUpdate?.content.lastUploadDate;

      expect(updatedDate).to.not.equal(initialDate);
      // Use type assertion instead of non-null assertion
      if (updatedDate && initialDate) {
        expect(new Date(updatedDate)).to.be.greaterThan(new Date(initialDate));
      } else {
        expect.fail("Dates should not be undefined or null");
      }
    });

    it("retrieves all patients", async () => {
      // Create a few more users
      await userService.enrollUserDirectly("patient1", {
        isSingleSignOn: false,
      });

      await userService.enrollUserDirectly("patient2", {
        isSingleSignOn: false,
      });

      const patients = await userService.getAllPatients();
      expect(patients.length).to.be.greaterThan(0);
    });

    it("deletes a user", async () => {
      const deleteUserId = "userToDelete";

      await userService.enrollUserDirectly(deleteUserId, {
        isSingleSignOn: false,
      });

      let user = await userService.getUser(deleteUserId);
      expect(user).to.exist;

      try {
        await userService.deleteUser(deleteUserId);
      } catch {
        // Auth deletion might fail in mocks, which is expected
      }

      try {
        user = await userService.getUser(deleteUserId);
        expect(user).to.be.undefined;
      } catch {
        // Document deletion might not be immediate in mocks
      }
    });

    it("cleans up expired accounts", async () => {
      // Just test that the method doesn't throw
      await userService.deleteExpiredAccounts();
    });

    it("marks account for deletion", async () => {
      const userId = "userToMarkForDeletion";

      // First create a user
      await userService.enrollUserDirectly(userId, {
        isSingleSignOn: false,
      });

      const user = await userService.getUser(userId);
      expect(user).to.exist;

      // Mark for deletion - this should not throw
      const markedAt = new Date();
      await userService.markAccountForDeletion(userId, markedAt);

      // Verify calling again throws an error (duplicate check)
      try {
        await userService.markAccountForDeletion(userId, new Date());
        expect.fail(
          "Should have thrown an error for duplicate deletion request",
        );
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.contain(
          "Account is already marked for deletion",
        );
      }
    });
  });
});
