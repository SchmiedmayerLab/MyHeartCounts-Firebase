// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";

export const healthStatsManualEntrySourceId =
  "edu.stanford.MyHeartCounts.ManualEntry";

export const healthStatsMonthDocumentVersion = 0;

// Metric ids of the app's `users/{uid}/stats/{metric}/months/{yyyy-MM}` documents.
export type HealthStatsMetricId =
  | "blood-pressure"
  | "bmi"
  | "weight"
  | "height"
  | "blood-lipids"
  | "blood-glucose-fasting";

export interface HealthStatsQuantityEntry {
  id: string;
  date: string;
  value: number;
  unit: string;
}

export interface HealthStatsBloodPressureEntry {
  id: string;
  date: string;
  systolic: number;
  diastolic: number;
  unit: string;
}

export type HealthStatsEntry =
  | HealthStatsQuantityEntry
  | HealthStatsBloodPressureEntry;

export const healthStatsMonthDocumentSchema = z.object({
  version: z.number(),
  metric: z.string(),
  samples: z.record(z.string(), z.array(z.unknown())).optional(),
});

export type HealthStatsMonthDocument = z.infer<
  typeof healthStatsMonthDocumentSchema
>;
