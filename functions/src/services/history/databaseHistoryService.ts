// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { isDeepStrictEqual } from "util";
import { type DocumentSnapshot } from "firebase-admin/firestore";
import { type Change } from "firebase-functions";
import { type DatabaseService } from "../database/databaseService.js";
import { type HistoryService } from "./historyService.js";

export class DatabaseHistoryService implements HistoryService {
  // Properties

  private readonly databaseService: DatabaseService;

  // Constructor

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
  }

  // Methods

  async isEmpty(): Promise<boolean> {
    const result = await this.databaseService.getQuery((collections) =>
      collections.history.limit(1),
    );
    return result.length === 0;
  }

  async recordChange(change: Change<DocumentSnapshot>): Promise<void> {
    const beforeData = change.before.data();
    const afterData = change.after.data();

    // Skip recording if no change
    if (beforeData && afterData && isDeepStrictEqual(beforeData, afterData))
      return;

    // Determine the path - prefer after.ref, fallback to before.ref
    const path = change.after.ref.path || change.before.ref.path;
    if (!path) return;

    // Determine the type of change
    let type: "created" | "updated" | "deleted";
    if (!change.before.exists && change.after.exists) {
      type = "created";
    } else if (change.before.exists && !change.after.exists) {
      type = "deleted";
    } else {
      type = "updated";
    }

    await this.databaseService.runTransaction((collections, transaction) => {
      transaction.create(collections.history.doc(), {
        path: path,
        data: afterData,
        date: new Date(),
        type: type,
        before: beforeData,
      });
    });
  }
}
