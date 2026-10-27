// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions";
import { storeLdlObservation } from "./ldlObservation.js";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import { type FHIRQuestionnaireResponse } from "../../models/index.js";
import {
  type Document,
  type DatabaseService,
} from "../database/databaseService.js";

export class HeartRiskLdlParsingQuestionnaireResponseService extends QuestionnaireResponseService {
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

    if (!targetQuestionnaireUrls.includes(response.content.questionnaire)) {
      return false;
    }

    try {
      const ldlValue = this.extractLdlValue(response.content);
      if (ldlValue === null) {
        logger.info(
          `HeartRiskLdlParsingService: No LDL value found for user ${userId}`,
        );
        return false;
      }

      await storeLdlObservation(this.databaseService, {
        userId,
        questionnaireResponseId: response.id,
        value: ldlValue,
        effectiveDateTime: new Date(response.content.authored),
      });

      logger.info(
        `HeartRiskLdlParsingService: Processed heart risk questionnaire for user ${userId}, LDL: ${ldlValue} mg/dL`,
      );

      return true;
    } catch (error) {
      logger.error(
        `HeartRiskLdlParsingService: Error processing heart risk questionnaire for user ${userId}: ${String(error)}`,
      );
      throw error;
    }
  }

  private extractLdlValue(response: FHIRQuestionnaireResponse): number | null {
    const ldlQuestionId = "1574e238-8804-4a17-fa5e-a764f094bd2b";

    try {
      const responseItem = response.leafResponseItem(ldlQuestionId);
      if (!responseItem?.answer || responseItem.answer.length === 0) {
        return null;
      }

      const answer = responseItem.answer[0];

      if (answer.valueQuantity?.value !== undefined) {
        return answer.valueQuantity.value;
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

      logger.warn(`No numeric LDL value found for linkId '${ldlQuestionId}'`);
      return null;
    } catch (error) {
      logger.error(`Failed to extract LDL value: ${String(error)}`);
      return null;
    }
  }
}
