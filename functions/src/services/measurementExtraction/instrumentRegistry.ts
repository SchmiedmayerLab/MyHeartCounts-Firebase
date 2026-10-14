// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  type ComponentsMeasurementId,
  type QuantityMeasurementId,
} from "./measurementCatalog.js";

export interface QuantityExtraction {
  kind: "quantity";
  measurement: QuantityMeasurementId;
  linkId: string;
}

export interface ComponentsExtraction {
  kind: "components";
  measurement: ComponentsMeasurementId;
  linkIds: Partial<Record<string, string>>;
}

export type MeasurementExtraction = QuantityExtraction | ComponentsExtraction;

export interface Instrument {
  questionnaire: string;
  extractions: MeasurementExtraction[];
}

const surveyUrl = (slug: string): string =>
  `https://myheartcounts.stanford.edu/fhir/survey/${slug}`;

// Stands in for SDC observationExtract markings until the dashboard questionnaires publish them.
export const instruments: Instrument[] = [
  {
    questionnaire: surveyUrl("blood-pressure"),
    extractions: [
      {
        kind: "components",
        measurement: "blood-pressure",
        linkIds: {
          systolic: "blood-pressure-systolic",
          diastolic: "blood-pressure-diastolic",
        },
      },
    ],
  },
  {
    questionnaire: surveyUrl("blood-lipids"),
    extractions: [
      {
        kind: "quantity",
        measurement: "ldl-cholesterol",
        linkId: "blood-lipids",
      },
    ],
  },
  {
    questionnaire: surveyUrl("blood-glucose-fasting"),
    extractions: [
      {
        kind: "quantity",
        measurement: "blood-glucose-unspecified-specimen",
        linkId: "blood-glucose-fasting",
      },
    ],
  },
  {
    questionnaire: surveyUrl("bmi"),
    extractions: [
      { kind: "quantity", measurement: "body-mass-index", linkId: "bmi" },
      // Compute mode also answers `height` (body-height, cm) and `weight` (body-weight, kg).
    ],
  },
];

export const instrumentForQuestionnaire = (
  canonical: string,
): Instrument | undefined => {
  const url = canonical.split("|")[0];
  return instruments.find((instrument) => instrument.questionnaire === url);
};
