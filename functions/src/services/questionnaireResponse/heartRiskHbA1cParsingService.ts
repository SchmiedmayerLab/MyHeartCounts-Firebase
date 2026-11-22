// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { logger } from "firebase-functions";
import {
  getHbA1cObservationConfig,
  questionnaireObservation,
} from "./fhirObservationConverter.js";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import {
  CodingSystem,
  mhcSampleTypeCollection,
  MhcSampleTypeCode,
  type FHIRQuestionnaireResponse,
} from "../../models/index.js";
import {
  type Document,
  type DatabaseService,
} from "../database/databaseService.js";

// HbA1c: converts an IFCC value (mmol/mol) to NGSP/DCCT percent. This is the inverse of the
// IFCC-NGSP master equation, NGSP % = 0.09148 * IFCC mmol/mol + 2.152, in its commonly used
// rounded form. The two scales are related by an offset, so a plain factor would be wrong.
export const hbA1cPercentFromMmolPerMol = (mmolPerMol: number): number =>
  mmolPerMol / 10.929 + 2.15;

export class HeartRiskHbA1cParsingQuestionnaireResponseService extends QuestionnaireResponseService {
  private readonly databaseService: DatabaseService;

  constructor(input: { databaseService: DatabaseService }) {
    super();
    this.databaseService = input.databaseService;
  }

  async handle(
    userId: string,
    response: Document<FHIRQuestionnaireResponse>,
    _options: { isNew: boolean },
  ): Promise<boolean> {
    const targetQuestionnaireUrls = [
      "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
    ];

    if (!this.targetsQuestionnaire(response.content, targetQuestionnaireUrls)) {
      return false;
    }

    try {
      const hbA1cValue = this.extractHbA1cValue(response.content);
      if (hbA1cValue === null) {
        logger.info(
          `HeartRiskHbA1cParsingService: No HbA1c value found for user ${userId}`,
        );
        return false;
      }

      await this.storeHbA1cObservation(
        userId,
        response.id,
        hbA1cValue,
        new Date(response.content.authored),
      );

      logger.info(
        `HeartRiskHbA1cParsingService: Processed heart risk questionnaire for user ${userId}, HbA1c: ${hbA1cValue} %`,
      );

      return true;
    } catch (error) {
      logger.error(
        `HeartRiskHbA1cParsingService: Error processing heart risk questionnaire for user ${userId}: ${String(error)}`,
      );
      throw error;
    }
  }

  private extractHbA1cValue(
    response: FHIRQuestionnaireResponse,
  ): number | null {
    const hbA1cQuestionId = "ad91308f-3d7c-407e-b4eb-6dcbfade7497";

    try {
      const responseItem = response.leafResponseItem(hbA1cQuestionId);
      if (!responseItem?.answer || responseItem.answer.length === 0) {
        return null;
      }

      const answer = responseItem.answer[0];

      if (answer.valueQuantity?.value !== undefined) {
        const { value, code, unit } = answer.valueQuantity;
        // The Imperial study asks for HbA1c in mmol/mol; the stored observation is always in %.
        return code === "mmol/mol" || unit === "mmol/mol" ?
            hbA1cPercentFromMmolPerMol(value)
          : value;
      }

      if (answer.valueInteger !== undefined) {
        return answer.valueInteger;
      }

      if (answer.valueDecimal !== undefined) {
        return answer.valueDecimal;
      }

      if (answer.valueString !== undefined) {
        const numericValue = parseFloat(answer.valueString);
        if (!isNaN(numericValue)) {
          return numericValue;
        }
      }

      logger.warn(
        `No numeric HbA1c value found for linkId '${hbA1cQuestionId}'`,
      );
      return null;
    } catch (error) {
      logger.error(`Failed to extract HbA1c value: ${String(error)}`);
      return null;
    }
  }

  private async storeHbA1cObservation(
    userId: string,
    questionnaireResponseId: string,
    hbA1cValue: number,
    authoredDateTime: Date,
  ): Promise<void> {
    const observationId = randomUUID();
    const observation = questionnaireObservation({
      config: getHbA1cObservationConfig(),
      value: hbA1cValue,
      date: authoredDateTime,
      questionnaireResponseId,
      observationId,
      userId,
      extraCodings: [
        {
          code: "4548-4",
          display: "Hemoglobin A1c/Hemoglobin.total in Blood",
          system: CodingSystem.loinc,
        },
      ],
    });

    const collectionName = mhcSampleTypeCollection(
      MhcSampleTypeCode.bloodGlucoseA1c,
    );

    return this.databaseService.runTransaction((collections, transaction) => {
      const ref = collections
        .userHealthObservations(userId, collectionName)
        .doc(observationId);
      transaction.set(ref, observation);
    });
  }
}
