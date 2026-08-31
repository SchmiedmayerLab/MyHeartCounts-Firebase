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

  // A canonical reference is `url` or `url|version`; the instrument's identity is the url.
  protected targetsQuestionnaire(
    response: FHIRQuestionnaireResponse,
    targetUrls: string[],
  ): boolean {
    const canonical = response.questionnaire;
    if (typeof canonical !== "string" || canonical.length === 0) return false;
    return targetUrls.includes(canonical.split("|", 1)[0]);
  }
}
