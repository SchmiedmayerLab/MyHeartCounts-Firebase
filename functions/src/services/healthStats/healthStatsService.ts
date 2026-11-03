// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { FieldPath } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import {
  type HealthStatsEntry,
  healthStatsManualEntrySourceId,
  type HealthStatsMetricId,
  healthStatsMonthDocumentSchema,
  healthStatsMonthDocumentVersion,
} from "../../models/index.js";
import { type DatabaseService } from "../database/databaseService.js";

export interface HealthStatsService {
  upsertManualEntries(
    userId: string,
    metric: HealthStatsMetricId,
    monthId: string,
    entries: HealthStatsEntry[],
  ): Promise<void>;
}

const entryField = (entry: unknown, field: string): unknown =>
  typeof entry === "object" && entry !== null && field in entry ?
    (entry as Record<string, unknown>)[field]
  : undefined;

const sortedByDate = <Entry>(entries: Entry[]): Entry[] =>
  [...entries].sort((lhs, rhs) => {
    const lhsDate = Date.parse(String(entryField(lhs, "date")));
    const rhsDate = Date.parse(String(entryField(rhs, "date")));
    return (isNaN(lhsDate) ? 0 : lhsDate) - (isNaN(rhsDate) ? 0 : rhsDate);
  });

export class DatabaseHealthStatsService implements HealthStatsService {
  private readonly databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
  }

  async upsertManualEntries(
    userId: string,
    metric: HealthStatsMetricId,
    monthId: string,
    entries: HealthStatsEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.databaseService.runTransaction(
      async (collections, transaction) => {
        const ref = collections.userHealthStatsMonth(userId, metric, monthId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
          transaction.set(ref, {
            version: healthStatsMonthDocumentVersion,
            metric,
            samples: {
              [healthStatsManualEntrySourceId]: sortedByDate(entries),
            },
          });
          return;
        }
        const document = healthStatsMonthDocumentSchema.safeParse(
          snapshot.data(),
        );
        if (
          !document.success ||
          document.data.version !== healthStatsMonthDocumentVersion ||
          document.data.metric !== metric
        ) {
          logger.warn(
            `HealthStatsService: Skipping ${ref.path}: unsupported stats document`,
          );
          return;
        }
        const ids = new Set<unknown>(entries.map((entry) => entry.id));
        const existing = (
          document.data.samples?.[healthStatsManualEntrySourceId] ?? []
        ).filter((entry) => !ids.has(entryField(entry, "id")));
        transaction.update(
          ref,
          new FieldPath("samples", healthStatsManualEntrySourceId),
          sortedByDate<unknown>([...existing, ...entries]),
        );
      },
    );
  }
}
