// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type EnrollUserOptions, type UserService } from "./userService.js";
import { User, type UserAuth } from "../../models/index.js";
import { type Document } from "../database/databaseService.js";

export class MockUserService implements UserService {
  // Methods - Auth

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAuth(userId: string): Promise<UserAuth> {
    switch (userId) {
      case "mockClinician":
        return {
          displayName: "Dr. XXX",
        };
      case "mockUser":
        return {
          displayName: "John Doe",
        };
      default:
        return {
          displayName: "Unknown",
        };
    }
  }

  updateAuth(_userId: string, _user: UserAuth): Promise<void> {
    return Promise.resolve();
  }

  updateClaims(_userId: string): Promise<void> {
    return Promise.resolve();
  }

  async enrollUserDirectly(
    userId: string,
    _options: EnrollUserOptions,
  ): Promise<Document<User>> {
    return this.getUser(userId);
  }

  finishUserEnrollment(_user: Document<User>): Promise<void> {
    return Promise.resolve();
  }

  // Methods - User

  getAllPatients(): Promise<Array<Document<User>>> {
    return Promise.resolve([]);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getUser(userId: string): Promise<Document<User>> {
    return {
      id: userId,
      path: "users/" + userId,
      lastUpdate: new Date(),
      content: new User({
        disabled: false,
        dateOfBirth: new Date("1970-01-02"),
        lastActiveDate: new Date("2024-04-04"),
        lastUploadDate: new Date("2024-04-04"),
        dateOfEnrollment: new Date("2024-04-02"),
        timeZone: "America/Los_Angeles",
        extendedActivityNudgesOptIn: true,
      }),
    };
  }

  updateLastUploadDate(_userId: string): Promise<void> {
    return Promise.resolve();
  }

  markAccountForDeletion(_userId: string, _markedAt: Date): Promise<void> {
    return Promise.resolve();
  }

  markAccountForStudyWithdrawal(
    _userId: string,
    _withdrawnAt: Date,
  ): Promise<void> {
    return Promise.resolve();
  }

  markAccountForStudyReenrollment(
    _userId: string,
    _reenrolledAt: Date,
  ): Promise<void> {
    return Promise.resolve();
  }

  deleteUser(_userId: string): Promise<void> {
    return Promise.resolve();
  }

  deleteExpiredAccounts(): Promise<void> {
    return Promise.resolve();
  }
}
