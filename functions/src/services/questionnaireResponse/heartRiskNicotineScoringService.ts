// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { logger } from "firebase-functions";
import {
  scoreToObservation,
  getNicotineObservationConfig,
} from "./fhirObservationConverter.js";
import { DefaultNicotineScoreCalculator } from "./nicotineScoringService.js";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import {
  type Score,
  type FHIRQuestionnaireResponse,
} from "../../models/index.js";
import {
  type Document,
  type DatabaseService,
} from "../database/databaseService.js";

export class HeartRiskNicotineScoringQuestionnaireResponseService extends QuestionnaireResponseService {
  private readonly databaseService: DatabaseService;
  private readonly scoreCalculator: DefaultNicotineScoreCalculator;

  constructor(input: { databaseService: DatabaseService }) {
    super();
    this.databaseService = input.databaseService;
    this.scoreCalculator = new DefaultNicotineScoreCalculator();
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
      const score = this.calculateScore(response.content);
      if (score === null) return false;

      await this.storeFHIRObservation(userId, response.id, score);

      logger.info(
        `HeartRiskNicotineScoringService: Processed Heart Risk questionnaire smoking response for user ${userId}, overall score: ${score.overallScore}`,
      );

      return true;
    } catch (error) {
      logger.error(
        `HeartRiskNicotineScoringService: Error processing Heart Risk questionnaire smoking response for user ${userId}: ${String(error)}`,
      );
      throw error;
    }
  }

  private calculateScore(response: FHIRQuestionnaireResponse): Score | null {
    try {
      const smokingStatus = this.extractSmokingStatus(response);
      if (smokingStatus === null) {
        logger.warn(
          "No smoking status found in Heart Risk questionnaire response",
        );
        return null;
      }
      return this.scoreCalculator.calculate(smokingStatus);
    } catch (error) {
      logger.error(
        `Failed to calculate nicotine score from Heart Risk questionnaire: ${String(error)}`,
      );
      return null;
    }
  }

  private extractSmokingStatus(
    response: FHIRQuestionnaireResponse,
  ): string | null {
    const linkId = "1a18f004-e6ab-4ee8-d5b2-284389d15e14";

    try {
      const responseItem = response.leafResponseItem(linkId);
      if (!responseItem?.answer || responseItem.answer.length === 0) {
        return null;
      }

      const answer = responseItem.answer[0];
      if (answer.valueCoding?.code) {
        return answer.valueCoding.code;
      }

      logger.warn(`No valueCoding.code found for linkId '${linkId}'`);
      return null;
    } catch (error) {
      logger.warn(
        `Failed to extract smoking status for ${linkId}: ${String(error)}`,
      );
      return null;
    }
  }

  private async storeFHIRObservation(
    userId: string,
    questionnaireResponseId: string,
    score: Score,
  ): Promise<void> {
    const config = getNicotineObservationConfig();
    const observationId = randomUUID();
    const observation = scoreToObservation(
      score,
      config,
      questionnaireResponseId,
      observationId,
      userId,
    );

    const collectionName =
      "HealthObservations_MHCCustomSampleTypeNicotineExposure";

    return this.databaseService.runTransaction((collections, transaction) => {
      const ref = collections
        .userHealthObservations(userId, collectionName)
        .doc(observationId);
      transaction.set(ref, observation);
    });
  }
}
