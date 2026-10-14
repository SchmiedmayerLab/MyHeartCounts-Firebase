// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import { logger } from "firebase-functions";
import {
  scoreToObservation,
  getDietObservationConfig,
} from "./fhirObservationConverter.js";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import { Score, type FHIRQuestionnaireResponse } from "../../models/index.js";
import {
  type Document,
  type DatabaseService,
} from "../database/databaseService.js";

export interface ScoreCalculator {
  calculate(answers: Record<string, boolean>): Score;
}

export class DietScoreCalculator implements ScoreCalculator {
  calculate(answers: Record<string, boolean>): Score {
    // Sum all boolean answers
    const totalPoints = Object.values(answers).reduce(
      (sum, answer) => sum + (answer ? 1 : 0),
      0,
    );

    // Keep category breakdown for tracking
    const categoryScores = {
      fruitsVegetables: this.calculateCategoryPoints(
        this.getFruitsVegetablesQuestions(),
        answers,
      ),
      fat: this.calculateCategoryPoints(this.getFatQuestions(), answers),
      starchyFoods: this.calculateCategoryPoints(
        this.getStarchyFoodsQuestions(),
        answers,
      ),
      sugar: this.calculateCategoryPoints(this.getSugarQuestions(), answers),
      fermentedFoods: this.calculateCategoryPoints(
        this.getFermentedFoodsQuestions(),
        answers,
      ),
      salt: this.calculateCategoryPoints(this.getSaltQuestions(), answers),
      alcohol: this.calculateCategoryPoints(
        this.getAlcoholQuestions(),
        answers,
      ),
      totalPoints: totalPoints,
    };

    return new Score({
      date: new Date(),
      overallScore: totalPoints,
      domainScores: categoryScores,
    });
  }

  private getFruitsVegetablesQuestions(): string[] {
    return [
      "92a6518b-61dd-442c-8082-09c3457daada", // Do you eat fruit and/or vegetables every day?
      "bbf31b7d-ea50-45bf-88a9-5c5c21466ce8", // Do you eat multiple varieties of fruit each week?
      "6616bfe1-d22f-488f-8ba6-0695cf19f634", // Do you eat multiple varieties of vegetables each week?
    ];
  }

  private getFatQuestions(): string[] {
    return [
      "fee4378b-c67a-4bf3-d99f-e94092207ee2", // Do you choose baked, steamed or grilled options when available, rather than fried foods?
      "ff78ee6d-a8ad-4d7b-80e1-2894dca64065", // Do you opt for lean cuts of meat or remove visible fat (e.g. skin on chicken, rind on bacon)?
      "50a6fdb1-d90c-416a-86a8-bf07602b701c", // Did you eat any oily fish last week (e.g. salmon, mackerel, sardines)?
      "ba4c8cee-f422-4a8a-8abc-e4418d8a87d1", // Do you include some unsalted nuts and seeds in your diet?
    ];
  }

  private getStarchyFoodsQuestions(): string[] {
    return [
      "055647aa-77aa-4877-81ae-40a2f08b8c5e", // Do you base your main meals around starchy foods (e.g., potatoes, pasta, rice, bread)?
      "784f7a2c-6ec8-414b-caa4-b59f1e8a6a1c", // Do you regularly include beans and/or lentils in your diet?
    ];
  }

  private getSugarQuestions(): string[] {
    return [
      "016e5729-7381-455d-b888-38e9e4365fa8", // Do you regularly eat sugar-coated breakfast cereals or add sugar to your breakfast cereals?
      "99e55082-b818-44c7-878b-8da477b300cc", // Do you add sugar to your drinks? (sweet tea, sugar in coffee/tea, etc)
      "a39e0c58-32a5-4ace-9980-e42363ae898d", // Do you regularly drink sugar sweetened soda? (pepsi, sprite, etc)
      "df1d2dcd-5087-4120-86b1-ca811498c655", // Do you regularly eat cakes, sweets, chocolate or biscuits?
    ];
  }

  private getFermentedFoodsQuestions(): string[] {
    return [
      "7d376d7b-4167-49b3-8600-683af1534e77", // Do you regularly eat greek or 'live' yogurt?
      "e5208b21-21d1-4f88-8c22-0580d4457172", // Do you regularly eat fermented foods (e.g. Kimchi, Sauerkraut)?
      "96ee1662-9b70-4f72-8f48-08ee91252d49", // Do you regularly have fermented drinks (e.g Kombucha, Kefir)?
    ];
  }

  private getSaltQuestions(): string[] {
    return [
      "a713aac6-c812-46e7-896c-ab9209d197fc", // Do you regularly add salt to food during cooking?
      "ed1856e6-5ba3-4ca2-85d3-1ff744ff492e", // Do you regularly eat savory snacks at work (e.g. chips, salted nuts)?
      "7e2609d6-2b29-4d70-8cbb-69f60d985876", // Do you regularly eat pre-prepared meals (e.g. sandwiches, ready meals, canned soups)?
      "a7ea3c2f-2f87-4fe3-811e-fe3c85a7c1b1", // Do you regularly eat processed meats (e.g. ham, bacon, salami)?
    ];
  }

  private getAlcoholQuestions(): string[] {
    return [
      "1ce40499-9d9c-4f91-e7c5-da0986503406", // Do you drink less than 1 unit of alcohol/day (women) or less than 2 units/day (men)?
    ];
  }

  private calculateCategoryPoints(
    questions: string[],
    answers: Record<string, boolean>,
  ): number {
    let points = 0;

    for (const questionId of questions) {
      const answer = answers[questionId];
      points += answer ? 1 : 0;
    }

    return points;
  }
}

export class DietScoringQuestionnaireResponseService extends QuestionnaireResponseService {
  private readonly databaseService: DatabaseService;
  private readonly scoreCalculator: ScoreCalculator;

  constructor(input: {
    databaseService: DatabaseService;
    scoreCalculator: ScoreCalculator;
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
      "https://myheartcounts.stanford.edu/fhir/survey/dietScore",
    ];

    if (!this.targetsQuestionnaire(response.content, targetQuestionnaireUrls)) {
      return false;
    }

    try {
      const score = this.calculateScore(response.content);
      if (score === null) return false;

      await this.storeFHIRObservation(userId, response.id, score);

      logger.info(
        `DietScoringService: Processed diet questionnaire response for user ${userId}, overall score: ${score.overallScore}`,
      );

      return true;
    } catch (error) {
      logger.error(
        `DietScoringService: Error processing diet questionnaire response for user ${userId}: ${String(error)}`,
      );
      throw error;
    }
  }

  private calculateScore(response: FHIRQuestionnaireResponse): Score | null {
    try {
      const answers = this.extractAnswers(response);
      return this.scoreCalculator.calculate(answers);
    } catch (error) {
      logger.error(`Failed to calculate score: ${String(error)}`);
      return null;
    }
  }

  private extractAnswers(
    response: FHIRQuestionnaireResponse,
  ): Record<string, boolean> {
    const answers: Record<string, boolean> = {};

    const questionLinkIds = [
      // Fruits and Vegetables
      "92a6518b-61dd-442c-8082-09c3457daada",
      "bbf31b7d-ea50-45bf-88a9-5c5c21466ce8",
      "6616bfe1-d22f-488f-8ba6-0695cf19f634",
      // Fat
      "fee4378b-c67a-4bf3-d99f-e94092207ee2",
      "ff78ee6d-a8ad-4d7b-80e1-2894dca64065",
      "50a6fdb1-d90c-416a-86a8-bf07602b701c",
      "ba4c8cee-f422-4a8a-8abc-e4418d8a87d1",
      // Starchy Foods
      "055647aa-77aa-4877-81ae-40a2f08b8c5e",
      "784f7a2c-6ec8-414b-caa4-b59f1e8a6a1c",
      // Sugar
      "016e5729-7381-455d-b888-38e9e4365fa8",
      "99e55082-b818-44c7-878b-8da477b300cc",
      "a39e0c58-32a5-4ace-9980-e42363ae898d",
      "df1d2dcd-5087-4120-86b1-ca811498c655",
      // Fermented Foods
      "7d376d7b-4167-49b3-8600-683af1534e77",
      "e5208b21-21d1-4f88-8c22-0580d4457172",
      "96ee1662-9b70-4f72-8f48-08ee91252d49",
      // Salt
      "a713aac6-c812-46e7-896c-ab9209d197fc",
      "ed1856e6-5ba3-4ca2-85d3-1ff744ff492e",
      "7e2609d6-2b29-4d70-8cbb-69f60d985876",
      "a7ea3c2f-2f87-4fe3-811e-fe3c85a7c1b1",
      // Alcohol
      "1ce40499-9d9c-4f91-e7c5-da0986503406",
    ];

    for (const linkId of questionLinkIds) {
      try {
        const answer = this.extractBooleanAnswer(linkId, response);
        if (answer !== null) {
          answers[linkId] = answer;
        }
      } catch (error) {
        logger.warn(`Failed to extract answer for ${linkId}: ${String(error)}`);
      }
    }

    return answers;
  }

  private extractBooleanAnswer(
    linkId: string,
    response: FHIRQuestionnaireResponse,
  ): boolean | null {
    const responseItem = response.leafResponseItem(linkId);
    if (!responseItem?.answer || responseItem.answer.length === 0) {
      return null;
    }

    const answer = responseItem.answer[0];
    if (answer.valueBoolean !== undefined) {
      return answer.valueBoolean;
    }

    logger.warn(`No boolean value found for linkId '${linkId}'`);
    return null;
  }

  private async storeFHIRObservation(
    userId: string,
    questionnaireResponseId: string,
    score: Score,
  ): Promise<void> {
    const config = getDietObservationConfig();
    const observationId = randomUUID();
    const observation = scoreToObservation(
      score,
      config,
      questionnaireResponseId,
      observationId,
      userId,
    );

    const collectionName =
      "HealthObservations_MHCCustomSampleTypeDietMEPAScore";

    return this.databaseService.runTransaction((collections, transaction) => {
      const ref = collections
        .userHealthObservations(userId, collectionName)
        .doc(observationId);
      transaction.set(ref, observation);
    });
  }
}
