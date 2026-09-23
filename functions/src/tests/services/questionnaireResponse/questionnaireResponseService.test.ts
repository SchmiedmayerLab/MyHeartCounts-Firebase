// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  FHIRQuestionnaireResponse,
  fhirQuestionnaireResponseConverter,
} from "../../../models/index.js";
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

  it("should score a Grove questionnaire response as the app stores it", async () => {
    const content = fhirQuestionnaireResponseConverter.value.schema.parse({
      resourceType: "QuestionnaireResponse",
      extension: [
        {
          url: "http://hl7.org/fhir/StructureDefinition/questionnaireresponse-completionMode",
          valueCodeableConcept: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/v3-ParticipationMode",
                code: "ELECTRONIC",
              },
            ],
          },
        },
        {
          url: "https://grovealliance.org/fhir/questionnaire/StructureDefinition/grove-questionnaire-writer-context",
          extension: [
            { url: "applicationName", valueString: "My Heart Counts" },
          ],
        },
      ],
      identifier: {
        system: `${survey}/nicotineExposure`,
        value: "f4c1e7a2-5b0d-4d8e-9a3f-2c6b1e8d7a90",
      },
      questionnaire: `${survey}/nicotineExposure|0.0.0`,
      status: "completed",
      subject: {
        identifier: {
          system:
            "https://myheartcounts.stanford.edu/fhir/identifiers/participant",
          value: "test-user",
        },
        type: "Patient",
      },
      authored: "2026-08-28T08:32:00-07:00",
      item: [
        {
          linkId: "dcb2277e-fe96-4f45-844a-ef58a9516380",
          answer: [
            {
              valueCoding: {
                system: "urn:uuid:049cbbd0-02fa-4fcd-83a7-65a112c1f607",
                code: "never-smoked/vaped",
              },
            },
          ],
        },
      ],
    });
    expect(content.authored.toISOString()).to.equal("2026-08-28T15:32:00.000Z");

    const service = new NicotineScoringQuestionnaireResponseService({
      databaseService: {
        getQuery: () => Promise.resolve([]),
        runTransaction: () => Promise.resolve(),
      } as Partial<DatabaseService> as DatabaseService,
      scoreCalculator: new DefaultNicotineScoreCalculator(),
    });
    const handled = await service.handle(
      "test-user",
      {
        id: "f4c1e7a2-5b0d-4d8e-9a3f-2c6b1e8d7a90",
        path: "users/test-user/questionnaireResponses/f4c1e7a2-5b0d-4d8e-9a3f-2c6b1e8d7a90",
        lastUpdate: new Date(),
        content,
      },
      { isNew: true },
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(handled).to.be.true;
  });
});
