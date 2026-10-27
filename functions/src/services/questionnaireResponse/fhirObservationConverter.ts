// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { getPackageVersion } from "../../helpers/packageVersion.js";
import {
  FHIRObservation,
  FHIRObservationStatus,
  mhcSampleTypeCodings,
  MhcSampleTypeCode,
  QuantityUnit,
  type FHIRCoding,
  type Score,
} from "../../models/index.js";

export interface QuestionnaireObservationConfig {
  customCode: MhcSampleTypeCode;
  display: string;
  unit: QuantityUnit;
}

export const questionnaireObservation = (input: {
  config: QuestionnaireObservationConfig;
  value: number;
  date: Date;
  questionnaireResponseId: string;
  observationId: string;
  userId: string;
  extraCodings?: FHIRCoding[];
}): FHIRObservation => {
  const { config } = input;
  return new FHIRObservation({
    id: input.observationId,
    status: FHIRObservationStatus.final,
    subject: {
      reference: `user/${input.userId}`,
    },
    code: {
      coding: [
        ...(input.extraCodings ?? []),
        ...mhcSampleTypeCodings(config.customCode, config.display),
      ],
      text: config.display,
    },
    valueQuantity: config.unit.fhirQuantity(input.value),
    effectiveDateTime: input.date,
    issued: new Date(),
    derivedFrom: [
      {
        reference: `QuestionnaireResponse/${input.questionnaireResponseId}`,
      },
    ],
    extension: [
      {
        url: "https://bdh.stanford.edu/fhir/defs/sampleUploadTimeZone",
        valueString: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      {
        url: "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/source/name",
        valueString: "My Heart Counts Firebase",
      },
      {
        url: "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/source/bundleIdentifier",
        valueString: "edu.stanford.MyHeartCounts",
      },
      {
        url: "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/version",
        valueString: getPackageVersion(),
      },
      {
        url: "https://grovealliance.org/fhir/core/StructureDefinition/sourceRevision/OSVersion",
        valueString: process.version,
      },
    ],
  });
};

export const scoreToObservation = (
  score: Score,
  config: QuestionnaireObservationConfig,
  questionnaireResponseId: string,
  observationId: string,
  userId: string,
): FHIRObservation =>
  questionnaireObservation({
    config,
    value: score.overallScore,
    date: score.date,
    questionnaireResponseId,
    observationId,
    userId,
  });

export const getDietObservationConfig = (): QuestionnaireObservationConfig => ({
  customCode: MhcSampleTypeCode.dietMEPAScore,
  display: "Diet MEPA Score",
  unit: QuantityUnit.score,
});

export const getNicotineObservationConfig =
  (): QuestionnaireObservationConfig => ({
    customCode: MhcSampleTypeCode.nicotineExposure,
    display: "Nicotine Exposure Score",
    unit: QuantityUnit.score,
  });

export const getWho5ObservationConfig = (): QuestionnaireObservationConfig => ({
  customCode: MhcSampleTypeCode.who5Score,
  display: "WHO-5 Well-Being Score",
  unit: QuantityUnit.score,
});

export const getLdlObservationConfig = (): QuestionnaireObservationConfig => ({
  customCode: MhcSampleTypeCode.bloodLipidMeasurement,
  display: "LDL Cholesterol",
  unit: QuantityUnit.mg_dL,
});
