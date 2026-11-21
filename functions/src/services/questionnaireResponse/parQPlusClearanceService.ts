// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions";
import { QuestionnaireResponseService } from "./questionnaireResponseService.js";
import {
  dateConverter,
  type FHIRQuestionnaireResponse,
  type FHIRQuestionnaireResponseItem,
} from "../../models/index.js";
import {
  type Document,
  type DatabaseService,
} from "../database/databaseService.js";

const parQPlusQuestionnaireUrl =
  "https://myheartcounts.stanford.edu/fhir/survey/parQplus";

// The seven general Par-Q+ questions. Every other boolean item in the
// questionnaire is a follow-up that only appears after a general "yes".
export const parQPlusGeneralQuestionLinkIds = [
  "626f009e-4cb3-45de-88fe-dc57d9dd59c3", // heart condition / high blood pressure
  "b70c2b1d-1d3e-471e-8f76-b836cd6b2806", // chest pain
  "f77a5328-867e-426b-a982-f247362142b1", // dizziness / lost consciousness
  "d300a205-e440-4390-81af-25b9123227ac", // other chronic condition
  "64b0ed3d-5585-4c36-ae2e-bc697cae7960", // prescribed medication
  "45961150-2e60-4862-c759-cb5f8b75c1bb", // bone / joint / soft tissue problem
  "97e68f50-4ec0-4f29-9709-0dc21de559b3", // medically supervised activity only
];

// Cleared when no follow-up question is "yes"; null when a general question is unanswered.
const parQPlusClearance = (
  response: FHIRQuestionnaireResponse,
): boolean | null => {
  const answers: Record<string, boolean> = {};
  const collect = (items: FHIRQuestionnaireResponseItem[]) => {
    for (const item of items) {
      const value = item.answer?.[0]?.valueBoolean;
      if (typeof value === "boolean" && item.linkId)
        answers[item.linkId] = value;
      collect(item.item ?? []);
    }
  };
  collect(response.item ?? []);

  if (parQPlusGeneralQuestionLinkIds.some((id) => !(id in answers))) {
    return null;
  }
  return !Object.entries(answers).some(
    ([linkId, value]) =>
      value && !parQPlusGeneralQuestionLinkIds.includes(linkId),
  );
};

export class ParQPlusClearanceQuestionnaireResponseService extends QuestionnaireResponseService {
  private readonly databaseService: DatabaseService;

  constructor(input: { databaseService: DatabaseService }) {
    super();
    this.databaseService = input.databaseService;
  }

  async handle(
    userId: string,
    response: Document<FHIRQuestionnaireResponse>,
    _options: { isNew: boolean },
  ): Promise<boolean> {
    if (
      !this.targetsQuestionnaire(response.content, [parQPlusQuestionnaireUrl])
    ) {
      return false;
    }

    const cleared = parQPlusClearance(response.content);
    if (cleared === null) {
      logger.warn(
        `ParQPlusClearanceService: Par-Q+ response ${response.id} of user ${userId} leaves a general question unanswered, flag not updated`,
      );
      return false;
    }

    const authored = response.content.authored;
    const written = await this.databaseService.runTransaction(
      async (collections, transaction) => {
        const userRef = collections.firestore.collection("users").doc(userId);
        const data = ((await transaction.get(userRef)).data() ?? {}) as Record<
          string,
          unknown
        >;
        // A re-synced older response must not overwrite a newer answer.
        if (
          data.parQPlusAuthored !== undefined &&
          dateConverter.schema.parse(data.parQPlusAuthored) > authored
        ) {
          return false;
        }
        transaction.update(userRef, {
          parQPlusCleared: cleared,
          parQPlusAuthored: dateConverter.encode(authored),
        });
        return true;
      },
    );

    logger.info(
      `ParQPlusClearanceService: Par-Q+ response ${response.id} of user ${userId} authored ${authored.toISOString()}: cleared=${cleared}, ${written ? "flag updated" : "older than stored flag, skipped"}`,
    );
    return true;
  }
}
