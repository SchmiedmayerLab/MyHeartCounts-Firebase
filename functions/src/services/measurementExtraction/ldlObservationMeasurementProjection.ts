// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  type ExtractedMeasurement,
  type MeasurementProjection,
} from "./questionnaireMeasurementExtractor.js";
import { type DatabaseService } from "../database/databaseService.js";
import { storeLdlObservation } from "../questionnaireResponse/ldlObservation.js";

export class LdlObservationMeasurementProjection implements MeasurementProjection {
  private readonly databaseService: DatabaseService;

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
  }

  async project(
    userId: string,
    measurements: ExtractedMeasurement[],
  ): Promise<void> {
    for (const measurement of measurements) {
      if (
        measurement.kind !== "quantity" ||
        measurement.measurement.id !== "ldl-cholesterol"
      ) {
        continue;
      }
      await storeLdlObservation(this.databaseService, {
        userId,
        questionnaireResponseId: measurement.questionnaireResponseId,
        value: measurement.value.value,
        effectiveDateTime: measurement.effective.toJSDate(),
      });
    }
  }
}
