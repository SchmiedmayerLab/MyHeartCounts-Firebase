// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { logger } from "firebase-functions";
import {
  scoreToObservation,
  getWho5ObservationConfig,
} from "./fhirObservationConverter.js";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import { Score, type FHIRQuestionnaireResponse } from "../../models/index.js";
import {
  type Document,
  type DatabaseService,
} from "../database/databaseService.js";

export interface Who5ScoreCalculator {
  calculate(answers: Record<string, number>): Score;
}

export class DefaultWho5ScoreCalculator implements Who5ScoreCalculator {
  private readonly questionLinkIds = [
    "f641ae63-47d5-447e-8dd4-afe1685d4b1f", // I have felt cheerful and in good spirits
    "a07c0c00-3f05-4273-f7fc-ca6a15686efe", // I have felt calm and relaxed
    "76b48a80-9eb9-4a14-8a8d-a09e980d2be3", // I have felt active and vigorous
    "23c4edfa-fdbe-4884-8d26-173599f7dffb", // I woke up feeling fresh and rested
    "80c92e40-1223-4cd8-806c-896e0868703f", // My daily life has been filled with things that interest me
  ];

  calculate(answers: Record<string, number>): Score {
    let totalScore = 0;

    for (const linkId of this.questionLinkIds) {
      const score = answers[linkId];
      if (score) {
        totalScore += score;
      }
    }

    return new Score({
      date: new Date(),
      overallScore: totalScore,
      domainScores: {},
    });
  }
}

export class Who5ScoringQuestionnaireResponseService extends QuestionnaireResponseService {
  private readonly databaseService: DatabaseService;
  private readonly scoreCalculator: Who5ScoreCalculator;

  private readonly questionLinkIds = [
    "f641ae63-47d5-447e-8dd4-afe1685d4b1f", // I have felt cheerful and in good spirits
    "a07c0c00-3f05-4273-f7fc-ca6a15686efe", // I have felt calm and relaxed
    "76b48a80-9eb9-4a14-8a8d-a09e980d2be3", // I have felt active and vigorous
    "23c4edfa-fdbe-4884-8d26-173599f7dffb", // I woke up feeling fresh and rested
    "80c92e40-1223-4cd8-806c-896e0868703f", // My daily life has been filled with things that interest me
  ];

  constructor(input: {
    databaseService: DatabaseService;
    scoreCalculator: Who5ScoreCalculator;
  }) {
    super();
    this.databaseService = input.databaseService;
    this.scoreCalculator = input.scoreCalculator;
  }

  async handle(
    userId: string,
    response: Document<FHIRQuestionnaireResponse>,
    _options: { isNew: boolean },
  ): Promise<boolean> {
    // Check if this service handles this questionnaire type
    const targetQuestionnaireUrls = [
      "https://myheartcounts.stanford.edu/fhir/survey/who5",
    ];

    if (!this.targetsQuestionnaire(response.content, targetQuestionnaireUrls)) {
      return false;
    }

    try {
      const score = this.calculateScore(response.content);
      if (score === null) return false;

      await this.storeFHIRObservation(userId, response.id, score);

      logger.info(
        `Who5ScoringService: Processed WHO-5 questionnaire response for user ${userId}, overall score: ${score.overallScore}`,
      );

      return true;
    } catch (error) {
      logger.error(
        `Who5ScoringService: Error processing WHO-5 questionnaire response for user ${userId}: ${String(error)}`,
      );
      throw error;
    }
  }

  private calculateScore(response: FHIRQuestionnaireResponse): Score | null {
    try {
      const answers = this.extractAnswers(response);

      // WHO-5 requires all 5 questions to be answered for a valid score
      if (Object.keys(answers).length < 5) {
        logger.warn(
          `WHO-5 questionnaire incomplete: only ${Object.keys(answers).length} of 5 questions answered`,
        );
        return null;
      }

      return this.scoreCalculator.calculate(answers);
    } catch (error) {
      logger.error(`Failed to calculate WHO-5 score: ${String(error)}`);
      return null;
    }
  }

  private extractAnswers(
    response: FHIRQuestionnaireResponse,
  ): Record<string, number> {
    const answers: Record<string, number> = {};

    for (const linkId of this.questionLinkIds) {
      try {
        const answer = this.extractNumericAnswer(linkId, response);
        if (answer !== null) {
          answers[linkId] = answer;
        }
      } catch (error) {
        logger.warn(`Failed to extract answer for ${linkId}: ${String(error)}`);
      }
    }

    return answers;
  }

  private extractNumericAnswer(
    linkId: string,
    response: FHIRQuestionnaireResponse,
  ): number | null {
    const responseItem = response.leafResponseItem(linkId);
    if (!responseItem?.answer || responseItem.answer.length === 0) {
      return null;
    }

    const answer = responseItem.answer[0];
    if (answer.valueCoding?.code) {
      return this.codingToScore(answer.valueCoding.code);
    }

    logger.warn(`No valueCoding.code found for linkId '${linkId}'`);
    return null;
  }

  private codingToScore(code: string): number {
    switch (code) {
      case "all-of-the-time":
        return 5;
      case "most-of-the-time":
        return 4;
      case "more-than-half-of-the-time":
        return 3;
      case "less-than-half-of-the-time":
        return 2;
      case "some-of-the-time":
        return 1;
      case "at-no-time":
        return 0;
      default:
        logger.warn(`Unknown WHO-5 answer code: ${code}`);
        return 0;
    }
  }

  private async storeFHIRObservation(
    userId: string,
    questionnaireResponseId: string,
    score: Score,
  ): Promise<void> {
    const config = getWho5ObservationConfig();
    const observationId = randomUUID();
    const observation = scoreToObservation(
      score,
      config,
      questionnaireResponseId,
      observationId,
      userId,
    );

    const collectionName = "HealthObservations_MHCCustomSampleTypeWHO5Score";

    return this.databaseService.runTransaction((collections, transaction) => {
      const ref = collections
        .userHealthObservations(userId, collectionName)
        .doc(observationId);
      transaction.set(ref, observation);
    });
  }
}
