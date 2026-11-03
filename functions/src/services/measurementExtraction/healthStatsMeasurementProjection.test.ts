// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { DateTime } from "luxon";
import { describe, it } from "mocha";
import {
  HealthStatsMeasurementProjection,
  healthStatsSample,
} from "./healthStatsMeasurementProjection.js";
import { instrumentForQuestionnaire } from "./instrumentRegistry.js";
import {
  measurementCatalog,
  type MeasurementId,
} from "./measurementCatalog.js";
import {
  type ExtractedMeasurement,
  type ExtractedQuantityMeasurement,
  extractMeasurements,
} from "./questionnaireMeasurementExtractor.js";
import {
  type HealthStatsEntry,
  type HealthStatsMetricId,
} from "../../models/index.js";
import {
  type QuestionnaireResponseFixture,
  questionnaireResponseFixture,
} from "../../tests/helpers/questionnaireResponses.js";
import { type HealthStatsService } from "../healthStats/healthStatsService.js";

const measurementsOf = (
  fixture: QuestionnaireResponseFixture,
): ExtractedMeasurement[] => {
  const response = questionnaireResponseFixture(fixture);
  const instrument = instrumentForQuestionnaire(response.questionnaire ?? "");
  if (instrument === undefined) throw new Error("No instrument for fixture.");
  return extractMeasurements(response, response.id ?? "", instrument)
    .measurements;
};

const weightAt = (iso: string): ExtractedQuantityMeasurement => ({
  kind: "quantity",
  measurement: measurementCatalog["body-weight"],
  value: { value: 70, quantity: measurementCatalog["body-weight"].quantity },
  questionnaireResponseId: "weight-response",
  effective: DateTime.fromISO(iso, { setZone: true }),
});

describe("healthStatsSample", () => {
  it("formats blood pressure entries in the app's wire format", () => {
    const [measurement] = measurementsOf("blood-pressure");
    expect(healthStatsSample(measurement)).to.deep.equal({
      metric: "blood-pressure",
      monthId: "2026-09",
      entry: {
        id: "B8C989D4-78FC-4CD8-985E-912E479FB631",
        date: "2026-09-01T13:21:10+02:00",
        systolic: 69,
        diastolic: 69,
        unit: "mmHg",
      },
    });
  });

  it("reports BMI in HealthKit's count unit", () => {
    const [measurement] = measurementsOf("bmi-direct");
    expect(healthStatsSample(measurement)).to.deep.equal({
      metric: "bmi",
      monthId: "2026-09",
      entry: {
        id: "4A075C57-7392-4FA8-AF6B-2A62764360FF",
        date: "2026-09-01T15:42:35+02:00",
        value: 25,
        unit: "count",
      },
    });
  });

  it("maps glucose to the fasting glucose dashboard metric", () => {
    const [measurement] = measurementsOf("blood-glucose-fasting");
    const sample = healthStatsSample(measurement);
    expect(sample?.metric).to.equal("blood-glucose-fasting");
    expect(sample?.entry).to.include({ value: 50, unit: "mg/dL" });
  });

  it("buckets by month in the source time zone and keeps the offset", () => {
    expect(healthStatsSample(weightAt("2026-09-01T00:30:00+02:00"))).to.include(
      {
        metric: "weight",
        monthId: "2026-09",
      },
    );
    expect(
      healthStatsSample(weightAt("2026-09-01T00:30:00+02:00"))?.entry.date,
    ).to.equal("2026-09-01T00:30:00+02:00");
    const utc = healthStatsSample(weightAt("2026-08-31T22:30:00Z"));
    expect(utc?.monthId).to.equal("2026-08");
    expect(utc?.entry.date).to.equal("2026-08-31T22:30:00+00:00");
  });
});

describe("healthStatsSample edge cases", () => {
  it("ignores measurements without a dashboard target", () => {
    const measurement = weightAt("2026-09-01T00:30:00+02:00");
    expect(
      healthStatsSample({
        ...measurement,
        measurement: {
          ...measurement.measurement,
          id: "unknown" as MeasurementId,
        },
      }),
    ).to.equal(undefined);
  });

  it("ignores blood pressure panels missing a component", async () => {
    const partial: ExtractedMeasurement = {
      kind: "components",
      measurement: measurementCatalog["blood-pressure"],
      components: {
        systolic: { value: 120, quantity: { code: "mm[Hg]", unit: "mmHg" } },
      },
      questionnaireResponseId: "partial",
      effective: DateTime.fromISO("2026-09-01T00:30:00+02:00", {
        setZone: true,
      }),
    };
    expect(healthStatsSample(partial)).to.equal(undefined);
    const projection = new HealthStatsMeasurementProjection({
      upsertManualEntries: () => {
        throw new Error("must not be called");
      },
    });
    await projection.project("user", [partial]);
  });
});

describe("HealthStatsMeasurementProjection", () => {
  it("writes one upsert per metric and month", async () => {
    const calls: Array<{
      metric: HealthStatsMetricId;
      monthId: string;
      entries: HealthStatsEntry[];
    }> = [];
    const healthStatsService: HealthStatsService = {
      upsertManualEntries: (_userId, metric, monthId, entries) => {
        calls.push({ metric, monthId, entries });
        return Promise.resolve();
      },
    };
    const projection = new HealthStatsMeasurementProjection(healthStatsService);
    await projection.project("user", [
      ...measurementsOf("bmi-direct"),
      ...measurementsOf("bmi-compute"),
      ...measurementsOf("blood-glucose-fasting"),
    ]);
    expect(calls.map((call) => [call.metric, call.monthId])).to.deep.equal([
      ["bmi", "2026-09"],
      ["blood-glucose-fasting", "2026-09"],
    ]);
    expect(calls[0].entries.map((entry) => entry.id)).to.deep.equal([
      "4A075C57-7392-4FA8-AF6B-2A62764360FF",
      "14EBB94E-3047-4BFA-872F-734C10E57A03",
    ]);
  });
});
