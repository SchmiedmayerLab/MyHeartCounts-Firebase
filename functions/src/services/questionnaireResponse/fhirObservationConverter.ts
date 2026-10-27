// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { getPackageVersion } from "../../helpers/packageVersion.js";
import {
  FHIRObservation,
  FHIRObservationStatus,
  mhcSampleTypeCodings,
  QuantityUnit,
  type Score,
  type FHIRCodeableConcept,
} from "../../models/index.js";

export interface QuestionnaireObservationConfig {
  customCode: string;
  display: string;
  unit: QuantityUnit;
}

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
    valueQuantity: config.unit.fhirQuantity(score.overallScore),
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
  unit: QuantityUnit.score,
});

export const getNicotineObservationConfig =
  (): QuestionnaireObservationConfig => ({
    customCode: "MHCCustomSampleTypeNicotineExposure",
    display: "Nicotine Exposure Score",
    unit: QuantityUnit.score,
  });

export const getWho5ObservationConfig = (): QuestionnaireObservationConfig => ({
  customCode: "MHCCustomSampleTypeWHO5Score",
  display: "WHO-5 Well-Being Score",
  unit: QuantityUnit.score,
});
