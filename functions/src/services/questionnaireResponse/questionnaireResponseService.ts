// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import type { FHIRQuestionnaireResponse } from "../../models/index.js";
import type { Document } from "../database/databaseService.js";

export abstract class QuestionnaireResponseService {
  abstract handle(
    userId: string,
    response: Document<FHIRQuestionnaireResponse>,
    options: { isNew: boolean },
  ): Promise<boolean>;

  protected targetsQuestionnaire(
    response: FHIRQuestionnaireResponse,
    targetUrls: string[],
  ): boolean {
    const url = response.questionnaireUrl;
    return url !== null && targetUrls.includes(url);
  }
}
