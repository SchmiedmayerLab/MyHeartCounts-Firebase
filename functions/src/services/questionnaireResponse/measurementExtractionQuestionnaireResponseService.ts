// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import { type FHIRQuestionnaireResponse } from "../../models/index.js";
import { type Document } from "../database/databaseService.js";
import { instrumentForQuestionnaire } from "../measurementExtraction/instrumentRegistry.js";
import {
  extractMeasurements,
  type MeasurementProjection,
} from "../measurementExtraction/questionnaireMeasurementExtractor.js";

export class MeasurementExtractionQuestionnaireResponseService extends QuestionnaireResponseService {
  private readonly projections: MeasurementProjection[];

  constructor(input: { projections: MeasurementProjection[] }) {
    super();
    this.projections = input.projections;
  }

  async handle(
    userId: string,
    response: Document<FHIRQuestionnaireResponse>,
    _options: { isNew: boolean },
  ): Promise<boolean> {
    const instrument = instrumentForQuestionnaire(
      response.content.questionnaire,
    );
    if (instrument === undefined) return false;

    const resource = response.content.value;
    if (resource === undefined) {
      logger.warn(
        `MeasurementExtractionService: No source resource for questionnaire response ${response.id} of user ${userId}`,
      );
      return false;
    }

    const { measurements, refusals } = extractMeasurements(
      resource,
      response.id,
      instrument,
    );
    for (const refusal of refusals) {
      logger.warn(
        `MeasurementExtractionService: Refused ${response.id} of user ${userId}: ${refusal}`,
      );
    }
    if (measurements.length === 0) return false;

    for (const projection of this.projections) {
      await projection.project(userId, measurements);
    }
    logger.info(
      `MeasurementExtractionService: Projected ${measurements.length} measurement(s) from ${response.id} for user ${userId}`,
    );
    return true;
  }
}
