// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  CodingSystem,
  type FHIRCodeableConcept,
  LoincCode,
  QuantityUnit,
} from "../../models/index.js";

// Units not present in the shared QuantityUnit catalog. They are only needed to
// stamp value quantities on produced observations (not for unit conversion), so
// constructing them locally is sufficient and avoids touching the shared file.
const milliseconds = new QuantityUnit("ms", "milliseconds");
const kilocalories = new QuantityUnit("kcal", "kcal");

const SPEZI_CUSTOM_SYSTEM = "https://spezi.stanford.edu";

const loinc = (code: LoincCode, display: string): FHIRCodeableConcept => ({
  text: display,
  coding: [{ system: CodingSystem.loinc, code, display }],
});

const custom = (code: string, display: string): FHIRCodeableConcept => ({
  text: display,
  coding: [{ system: SPEZI_CUSTOM_SYSTEM, code, display }],
});

export interface MetricSpec {
  /** Collection suffix -> `{Provider}Observations_{metric}` (alphanumeric). */
  metric: string;
  concept: FHIRCodeableConcept;
  unit: QuantityUnit;
}

/**
 * The curated cardiovascular-core metric catalog shared by every provider
 * adapter. Providers map their native fields onto these keys so that, e.g., an
 * Oura and a Fitbit resting heart rate land in analogously-shaped observations.
 */
export const MetricSpecs = {
  heartRate: {
    metric: "heartRate",
    concept: loinc(LoincCode.heartRate, "Heart rate"),
    unit: QuantityUnit.bpm,
  },
  restingHeartRate: {
    metric: "restingHeartRate",
    concept: loinc(LoincCode.restingHeartRate, "Resting heart rate"),
    unit: QuantityUnit.bpm,
  },
  heartRateVariability: {
    metric: "heartRateVariability",
    concept: loinc(
      LoincCode.heartRateVariabilitySDNN,
      "Heart rate variability",
    ),
    unit: milliseconds,
  },
  oxygenSaturation: {
    metric: "oxygenSaturation",
    concept: loinc(LoincCode.oxygenSaturation, "Oxygen saturation"),
    unit: QuantityUnit.percent,
  },
  respiratoryRate: {
    metric: "respiratoryRate",
    concept: loinc(LoincCode.respiratoryRate, "Respiratory rate"),
    unit: QuantityUnit.resp_min,
  },
  bodyTemperature: {
    metric: "bodyTemperature",
    concept: loinc(LoincCode.bodyTemperature, "Body temperature"),
    unit: QuantityUnit.celsius,
  },
  steps: {
    metric: "steps",
    concept: loinc(LoincCode.stepCount, "Step count"),
    unit: QuantityUnit.steps,
  },
  distanceWalkingRunning: {
    metric: "distanceWalkingRunning",
    concept: loinc(LoincCode.distanceWalkingRunning, "Distance walked/run"),
    unit: QuantityUnit.meters,
  },
  activeEnergyBurned: {
    metric: "activeEnergyBurned",
    concept: custom(
      "MHCCustomSampleTypeActiveEnergyBurned",
      "Active energy burned",
    ),
    unit: kilocalories,
  },
  bodyWeight: {
    metric: "bodyWeight",
    concept: loinc(LoincCode.bodyWeight, "Body weight"),
    unit: QuantityUnit.kg,
  },
  bodyFatPercentage: {
    metric: "bodyFatPercentage",
    concept: loinc(LoincCode.bodyFatPercentage, "Body fat percentage"),
    unit: QuantityUnit.percent,
  },
  vo2Max: {
    metric: "vo2Max",
    concept: loinc(LoincCode.vo2Max, "VO2 max"),
    unit: QuantityUnit.mL_kg_min,
  },
  sleepDuration: {
    metric: "sleepDuration",
    concept: custom("MHCCustomSampleTypeSleepDuration", "Sleep duration"),
    unit: QuantityUnit.minutes,
  },
  sleepDeep: {
    metric: "sleepDeep",
    concept: custom("MHCCustomSampleTypeSleepDeep", "Deep sleep duration"),
    unit: QuantityUnit.minutes,
  },
  sleepRem: {
    metric: "sleepRem",
    concept: custom("MHCCustomSampleTypeSleepRem", "REM sleep duration"),
    unit: QuantityUnit.minutes,
  },
  sleepLight: {
    metric: "sleepLight",
    concept: custom("MHCCustomSampleTypeSleepLight", "Light sleep duration"),
    unit: QuantityUnit.minutes,
  },
  sleepAwake: {
    metric: "sleepAwake",
    concept: custom("MHCCustomSampleTypeSleepAwake", "Awake duration"),
    unit: QuantityUnit.minutes,
  },
  workoutDuration: {
    metric: "workoutDuration",
    concept: custom("MHCCustomSampleTypeWorkoutDuration", "Workout duration"),
    unit: QuantityUnit.minutes,
  },
} satisfies Record<string, MetricSpec>;

export type MetricKey = keyof typeof MetricSpecs;
