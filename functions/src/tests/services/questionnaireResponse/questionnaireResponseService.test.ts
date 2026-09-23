// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { describe, it } from "mocha";
import { FHIRQuestionnaireResponse } from "../../../models/index.js";
import type { DatabaseService } from "../../../services/database/databaseService.js";
import {
  DietScoreCalculator,
  DietScoringQuestionnaireResponseService,
} from "../../../services/questionnaireResponse/dietScoringService.js";
import { HeartRiskLdlParsingQuestionnaireResponseService } from "../../../services/questionnaireResponse/heartRiskLdlParsingService.js";
import { HeartRiskNicotineScoringQuestionnaireResponseService } from "../../../services/questionnaireResponse/heartRiskNicotineScoringService.js";
import {
  DefaultNicotineScoreCalculator,
  NicotineScoringQuestionnaireResponseService,
} from "../../../services/questionnaireResponse/nicotineScoringService.js";
import {
  type QuestionnaireResponseService,
  questionnaireCanonicalUrl,
} from "../../../services/questionnaireResponse/questionnaireResponseService.js";
import {
  DefaultWho5ScoreCalculator,
  Who5ScoringQuestionnaireResponseService,
} from "../../../services/questionnaireResponse/who5ScoringService.js";

const survey = "https://myheartcounts.stanford.edu/fhir/survey";

describe("questionnaireCanonicalUrl", () => {
  it("should return the url of an unversioned canonical", () => {
    expect(questionnaireCanonicalUrl(`${survey}/who5`)).to.equal(
      `${survey}/who5`,
    );
  });

  it("should return the url of a versioned canonical", () => {
    expect(questionnaireCanonicalUrl(`${survey}/who5|0.0.0`)).to.equal(
      `${survey}/who5`,
    );
  });

  for (const canonical of [
    "",
    "|0.0.0",
    `${survey}/who5|`,
    `${survey}/who5|0.0.0|1.0.0`,
    `${survey}/who5#fragment`,
    `${survey}/who5|0.0.0#fragment`,
  ]) {
    it(`should reject the malformed canonical '${canonical}'`, () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(questionnaireCanonicalUrl(canonical)).to.be.null;
    });
  }
});

describe("QuestionnaireResponseService canonical matching", () => {
  const databaseService = {
    getQuery: () => Promise.reject(new Error("unexpected database access")),
    runTransaction: () =>
      Promise.reject(new Error("unexpected database access")),
  } as Partial<DatabaseService> as DatabaseService;

  const services: Array<[string, QuestionnaireResponseService]> = [
    [
      "dietScore",
      new DietScoringQuestionnaireResponseService({
        databaseService,
        scoreCalculator: new DietScoreCalculator(),
      }),
    ],
    [
      "heartRisk",
      new HeartRiskLdlParsingQuestionnaireResponseService({ databaseService }),
    ],
    [
      "heartRisk",
      new HeartRiskNicotineScoringQuestionnaireResponseService({
        databaseService,
      }),
    ],
    [
      "nicotineExposure",
      new NicotineScoringQuestionnaireResponseService({
        databaseService,
        scoreCalculator: new DefaultNicotineScoreCalculator(),
      }),
    ],
    [
      "who5",
      new Who5ScoringQuestionnaireResponseService({
        databaseService,
        scoreCalculator: new DefaultWho5ScoreCalculator(),
      }),
    ],
  ];

  for (const [instrument, service] of services) {
    it(`${service.constructor.name} should ignore malformed ${instrument} canonicals`, async () => {
      for (const canonical of [
        `${survey}/${instrument}|`,
        `${survey}/${instrument}|0.0.0|1.0.0`,
        `${survey}/${instrument}|0.0.0#fragment`,
      ]) {
        const handled = await service.handle(
          "test-user",
          {
            id: "test-response-id",
            path: "users/test-user/questionnaireResponses/test-response-id",
            lastUpdate: new Date(),
            content: new FHIRQuestionnaireResponse({
              id: "test-response",
              authored: new Date(),
              questionnaire: canonical,
              item: [],
            }),
          },
          { isNew: true },
        );
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(handled, canonical).to.be.false;
      }
    });
  }
});
