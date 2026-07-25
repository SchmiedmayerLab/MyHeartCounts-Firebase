// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { logger } from "firebase-functions";
import {
  scoreToObservation,
  getNicotineObservationConfig,
} from "./fhirObservationConverter.js";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import {
  Score,
  type FHIRQuestionnaireResponse,
  type FHIRObservation,
} from "../../models/index.js";
import {
  type Document,
  type DatabaseService,
} from "../database/databaseService.js";

export interface NicotineScoreCalculator {
  calculate(smokingStatus: string): Score | null;
}

export class DefaultNicotineScoreCalculator implements NicotineScoreCalculator {
  calculate(smokingStatus: string): Score | null {
    const overallScore = this.smokingStatusToScore(smokingStatus);

    if (overallScore === null) {
      return null;
    }

    return new Score({
      date: new Date(),
      overallScore: overallScore,
      domainScores: {
        statusScore: overallScore,
      },
    });
  }

  private smokingStatusToScore(smokingStatus: string): number | null {
    // Lookup table based on iOS NicotineExposureCategoryValues enum: https://github.com/SchmiedmayerLab/MyHeartCounts-iOS/blob/main/MyHeartCounts/Heart%20Health%20Dashboard/CustomHealthSample.swift
    switch (smokingStatus) {
      case "never-smoked/vaped":
        return 0;
      case "quit->5-years-ago":
        return 1;
      case "quit-1-5-years-ago":
        return 2;
      case "quit-<1-year-ago":
        return 3;
      case "light-smoker/vaper-(<10/day)":
      case "moderate-smoker/vaper-(10-to-19/day)":
      case "heavy-smoker/vaper-(>20/day)":
        return 4;
      default:
        logger.warn(`Unknown smoking status: ${smokingStatus}`);
        return null;
    }
  }
}

export class NicotineScoringQuestionnaireResponseService extends QuestionnaireResponseService {
  private readonly databaseService: DatabaseService;
  private readonly scoreCalculator: NicotineScoreCalculator;

  constructor(input: {
    databaseService: DatabaseService;
    scoreCalculator: NicotineScoreCalculator;
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
      "https://myheartcounts.stanford.edu/fhir/survey/nicotineExposure",
    ];

    if (!targetQuestionnaireUrls.includes(response.content.questionnaire)) {
      return false;
    }

    try {
      const score = this.calculateScore(response.content);
      if (score === null) return false;

      const _previousScore = await this.getLatestScore(userId);

      // Store FHIR observation
      await this.storeFHIRObservation(userId, response.id, score);

      logger.info(
        `NicotineScoringService: Processed nicotine questionnaire response for user ${userId}, overall score: ${score.overallScore}`,
      );

      return true;
    } catch (error) {
      logger.error(
        `NicotineScoringService: Error processing nicotine questionnaire response for user ${userId}: ${String(error)}`,
      );
      throw error;
    }
  }

  private calculateScore(response: FHIRQuestionnaireResponse): Score | null {
    try {
      const smokingStatus = this.extractSmokingStatus(response);
      if (smokingStatus === null) {
        logger.warn(
          "No smoking status found in nicotine questionnaire response",
        );
        return null;
      }
      return this.scoreCalculator.calculate(smokingStatus);
    } catch (error) {
      logger.error(`Failed to calculate nicotine score: ${String(error)}`);
      return null;
    }
  }

  private extractSmokingStatus(
    response: FHIRQuestionnaireResponse,
  ): string | null {
    // linkId for the nicotine/smoking question
    const linkId = "dcb2277e-fe96-4f45-844a-ef58a9516380";

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

  private async getLatestScore(
    userId: string,
  ): Promise<Document<Score> | undefined> {
    const collectionName =
      "HealthObservations_MHCCustomSampleTypeNicotineExposure";
    const result = await this.databaseService.getQuery<FHIRObservation>(
      (collections) =>
        collections
          .userHealthObservations(userId, collectionName)
          .orderBy("effectiveDateTime", "desc")
          .limit(1),
    );

    const latestObservation = result.at(0);
    if (!latestObservation) return undefined;

    // Convert FHIR observation back to Score
    const score = this.observationToScore(latestObservation.content);
    return {
      id: latestObservation.id,
      content: score,
      path: latestObservation.path,
      lastUpdate: latestObservation.lastUpdate,
    };
  }

  private observationToScore(observation: FHIRObservation): Score {
    return new Score({
      overallScore: observation.valueQuantity?.value ?? 0,
      date: observation.effectiveDateTime ?? new Date(),
      domainScores: {},
    });
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
