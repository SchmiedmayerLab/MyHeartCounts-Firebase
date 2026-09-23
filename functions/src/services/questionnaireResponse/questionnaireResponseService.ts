// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import type { FHIRQuestionnaireResponse } from "../../models/index.js";
import type { Document } from "../database/databaseService.js";

// Scoring keys on the instrument's url and ignores `|version`: the scored linkIds are stable across versions.
export const questionnaireCanonicalUrl = (canonical: string): string | null => {
  if (canonical.includes("#")) return null;
  const [url, version, ...rest] = canonical.split("|");
  if (url === "" || version === "" || rest.length > 0) return null;
  return url;
};

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
    const url = questionnaireCanonicalUrl(response.questionnaire);
    return url !== null && targetUrls.includes(url);
  }
}
