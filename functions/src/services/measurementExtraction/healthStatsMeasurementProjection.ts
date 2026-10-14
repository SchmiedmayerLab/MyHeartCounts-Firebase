// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type DateTime } from "luxon";
import { type MeasurementId } from "./measurementCatalog.js";
import {
  type ExtractedMeasurement,
  type MeasurementProjection,
} from "./questionnaireMeasurementExtractor.js";
import {
  type HealthStatsEntry,
  type HealthStatsMetricId,
} from "../../models/index.js";
import { type HealthStatsService } from "../healthStats/healthStatsService.js";

interface HealthStatsTarget {
  metric: HealthStatsMetricId;
  unit: string;
}

// The app parses `unit` with HKUnit, so BMI must use HealthKit's `count`.
const healthStatsTargets: Partial<Record<MeasurementId, HealthStatsTarget>> = {
  "blood-pressure": { metric: "blood-pressure", unit: "mmHg" },
  "body-mass-index": { metric: "bmi", unit: "count" },
  "body-weight": { metric: "weight", unit: "kg" },
  "body-height": { metric: "height", unit: "cm" },
  "blood-glucose-unspecified-specimen": {
    metric: "blood-glucose-fasting",
    unit: "mg/dL",
  },
  "ldl-cholesterol": { metric: "blood-lipids", unit: "mg/dL" },
};

export const healthStatsDateFormat = "yyyy-MM-dd'T'HH:mm:ssZZ";

export const healthStatsMonthId = (dateTime: DateTime): string =>
  dateTime.toFormat("yyyy-MM");

export interface HealthStatsSample {
  metric: HealthStatsMetricId;
  monthId: string;
  entry: HealthStatsEntry;
}

export const healthStatsSample = (
  measurement: ExtractedMeasurement,
): HealthStatsSample | undefined => {
  const target = healthStatsTargets[measurement.measurement.id];
  if (target === undefined) return undefined;
  const base = {
    id: measurement.questionnaireResponseId,
    date: measurement.effective.toFormat(healthStatsDateFormat),
    unit: target.unit,
  };
  let entry: HealthStatsEntry;
  if (measurement.kind === "quantity") {
    entry = { ...base, value: measurement.value.value };
  } else {
    const { systolic, diastolic } = measurement.components;
    if (systolic === undefined || diastolic === undefined) return undefined;
    entry = { ...base, systolic: systolic.value, diastolic: diastolic.value };
  }
  return {
    metric: target.metric,
    monthId: healthStatsMonthId(measurement.effective),
    entry,
  };
};

export class HealthStatsMeasurementProjection implements MeasurementProjection {
  private readonly healthStatsService: HealthStatsService;

  constructor(healthStatsService: HealthStatsService) {
    this.healthStatsService = healthStatsService;
  }

  async project(
    userId: string,
    measurements: ExtractedMeasurement[],
  ): Promise<void> {
    const groups: Record<string, HealthStatsSample[]> = {};
    for (const measurement of measurements) {
      const sample = healthStatsSample(measurement);
      if (sample === undefined) continue;
      const key = `${sample.metric}/${sample.monthId}`;
      groups[key] = [...(groups[key] ?? []), sample];
    }
    for (const samples of Object.values(groups)) {
      await this.healthStatsService.upsertManualEntries(
        userId,
        samples[0].metric,
        samples[0].monthId,
        samples.map((sample) => sample.entry),
      );
    }
  }
}
