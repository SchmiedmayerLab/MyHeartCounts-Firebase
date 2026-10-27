// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { getPackageVersion } from "../../helpers/packageVersion.js";
import {
  CodingSystem,
  FHIRObservation,
  FHIRObservationStatus,
  type FHIRCoding,
  type Score,
  type FHIRCodeableConcept,
} from "../../models/index.js";

export interface QuestionnaireObservationConfig {
  customCode: string;
  display: string;
  unit: string;
  unitSystem: string;
  ucumCode?: string;
}

export const mhcSampleTypeCodings = (
  code: string,
  display: string,
): FHIRCoding[] =>
  [CodingSystem.mhcSampleType, CodingSystem.mhcSampleTypeSuperseded].map(
    (system) => ({ code, display, system }),
  );

export const scoreToObservation = (
  score: Score,
  config: QuestionnaireObservationConfig,
  questionnaireResponseId: string,
  observationId: string,
  userId: string,
): FHIRObservation => {
  const codeableConcept: FHIRCodeableConcept = {
    coding: mhcSampleTypeCodings(config.customCode, config.display),
    text: config.display,
  };

  return new FHIRObservation({
    id: observationId,
    status: FHIRObservationStatus.final,
    subject: {
      reference: `user/${userId}`,
    },
    code: codeableConcept,
    valueQuantity: {
      value: score.overallScore,
      unit: config.unit,
      system: config.unitSystem,
      code: config.ucumCode ?? config.unit,
    },
    effectiveDateTime: score.date,
    issued: new Date(),
    derivedFrom: [
      {
        reference: `QuestionnaireResponse/${questionnaireResponseId}`,
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

export const getDietObservationConfig = (): QuestionnaireObservationConfig => ({
  customCode: "MHCCustomSampleTypeDietMEPAScore",
  display: "Diet MEPA Score",
  unit: "count",
  unitSystem: CodingSystem.ucum,
  ucumCode: "{count}",
});

export const getNicotineObservationConfig =
  (): QuestionnaireObservationConfig => ({
    customCode: "MHCCustomSampleTypeNicotineExposure",
    display: "Nicotine Exposure Score",
    unit: "count",
    unitSystem: CodingSystem.ucum,
    ucumCode: "{count}",
  });

export const getWho5ObservationConfig = (): QuestionnaireObservationConfig => ({
  customCode: "MHCCustomSampleTypeWHO5Score",
  display: "WHO-5 Well-Being Score",
  unit: "count",
  unitSystem: CodingSystem.ucum,
  ucumCode: "{count}",
});
