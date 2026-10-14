// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { FHIRObservation, FHIRObservationStatus } from "../../models/index.js";
import { type DatabaseService } from "../database/databaseService.js";

export const ldlObservationCollectionName =
  "HealthObservations_MHCCustomSampleTypeBloodLipidMeasurement";

export interface LdlObservationInput {
  userId: string;
  questionnaireResponseId: string;
  value: number;
  effectiveDateTime: Date;
}

export const ldlObservation = (
  input: LdlObservationInput,
  observationId: string,
): FHIRObservation =>
  new FHIRObservation({
    id: observationId,
    status: FHIRObservationStatus.final,
    subject: {
      reference: `user/${input.userId}`,
    },
    code: {
      coding: [
        {
          code: "18262-6",
          system: "http://loinc.org",
        },
        {
          code: "MHCCustomSampleTypeBloodLipidMeasurement",
          display: "LDL Cholesterol",
          system: "https://spezi.stanford.edu",
        },
      ],
    },
    valueQuantity: {
      value: input.value,
      unit: "mg/dL",
      code: "18262-6",
      system: "http://loinc.org",
    },
    effectiveDateTime: input.effectiveDateTime,
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
    ],
  });

export const storeLdlObservation = async (
  databaseService: DatabaseService,
  input: LdlObservationInput,
): Promise<void> => {
  const observationId = randomUUID();
  const observation = ldlObservation(input, observationId);
  await databaseService.runTransaction((collections, transaction) => {
    const ref = collections
      .userHealthObservations(input.userId, ldlObservationCollectionName)
      .doc(observationId);
    transaction.set(ref, observation);
  });
};
