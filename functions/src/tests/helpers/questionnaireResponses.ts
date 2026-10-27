// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { Timestamp } from "firebase-admin/firestore";
import {
  type FHIRQuestionnaireResponse,
  fhirQuestionnaireResponseConverter,
} from "../../models/index.js";
import { type Document } from "../../services/database/databaseService.js";

export const testUserId = "test-user";
export const surveyUrl = "https://myheartcounts.stanford.edu/fhir/survey";
export const authoredAt = new Date("2026-08-28T15:32:00.000Z");

// Shape written by the Grove builds of the iOS app.
export const groveQuestionnaireResponse = (
  instrument: string,
  id: string,
  item: unknown[],
): FHIRQuestionnaireResponse =>
  fhirQuestionnaireResponseConverter.value.schema.parse({
    resourceType: "QuestionnaireResponse",
    meta: {
      profile: [
        "https://grovealliance.org/fhir/questionnaire/StructureDefinition/grove-questionnaire-response",
      ],
    },
    identifier: { system: `${surveyUrl}/${instrument}`, value: id },
    language: "en-US",
    questionnaire: `${surveyUrl}/${instrument}|0.2.5`,
    status: "completed",
    subject: {
      identifier: {
        system:
          "https://myheartcounts.stanford.edu/fhir/identifiers/participant",
        value: testUserId,
      },
      type: "Patient",
    },
    authored: "2026-08-28T08:32:00-07:00",
    item,
  });

// Shape written by iOS 4.0.x.
export const preGroveQuestionnaireResponse = (
  instrument: string,
  id: string,
  item: unknown[],
): FHIRQuestionnaireResponse =>
  fhirQuestionnaireResponseConverter.value.schema.parse({
    resourceType: "QuestionnaireResponse",
    id,
    questionnaire: `${surveyUrl}/${instrument}`,
    status: "completed",
    authored: Timestamp.fromDate(authoredAt),
    item,
  });

export const questionnaireResponseDocument = (
  id: string,
  content: FHIRQuestionnaireResponse,
): Document<FHIRQuestionnaireResponse> => ({
  id,
  path: `users/${testUserId}/questionnaireResponses/${id}`,
  lastUpdate: new Date(),
  content,
});
