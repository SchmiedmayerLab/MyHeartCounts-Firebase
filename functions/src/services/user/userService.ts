// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type User, type UserAuth } from "../../models/index.js";
import { type Document } from "../database/databaseService.js";

export interface EnrollUserOptions {
  isSingleSignOn: boolean;
}

export interface UserService {
  // Auth

  getAuth(userId: string): Promise<UserAuth>;
  updateAuth(userId: string, auth: UserAuth): Promise<void>;
  updateClaims(userId: string): Promise<void>;

  // Users

  enrollUserDirectly(
    userId: string,
    options: EnrollUserOptions,
  ): Promise<Document<User>>;
  finishUserEnrollment(user: Document<User>): Promise<void>;
  getAllPatients(): Promise<Array<Document<User>>>;
  getUser(userId: string): Promise<Document<User> | undefined>;
  updateLastUploadDate(userId: string): Promise<void>;
  markAccountForDeletion(userId: string, markedAt: Date): Promise<void>;
  markAccountForStudyWithdrawal(
    userId: string,
    withdrawnAt: Date,
  ): Promise<void>;
  markAccountForStudyReenrollment(
    userId: string,
    reenrolledAt: Date,
  ): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  deleteExpiredAccounts(): Promise<void>;
}
