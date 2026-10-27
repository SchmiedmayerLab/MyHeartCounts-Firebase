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
import {
  preGroveQuestionnaireResponse,
  questionnaireResponseDocument,
  surveyUrl,
  testUserId,
} from "../../helpers/questionnaireResponses.js";

describe("questionnaireCanonicalUrl", () => {
  it("should return the url of an unversioned canonical", () => {
    expect(questionnaireCanonicalUrl(`${surveyUrl}/who5`)).to.equal(
      `${surveyUrl}/who5`,
    );
  });

  it("should return the url of a versioned canonical", () => {
    expect(questionnaireCanonicalUrl(`${surveyUrl}/who5|0.0.0`)).to.equal(
      `${surveyUrl}/who5`,
    );
  });

  for (const canonical of [
    "",
    "|0.0.0",
    `${surveyUrl}/who5|`,
    `${surveyUrl}/who5|0.0.0|1.0.0`,
    `${surveyUrl}/who5#fragment`,
    `${surveyUrl}/who5|0.0.0#fragment`,
  ]) {
    it(`should reject the malformed canonical '${canonical}'`, () => {
      expect(questionnaireCanonicalUrl(canonical)).to.equal(null);
    });
  }
});

describe("QuestionnaireResponseService canonical matching", () => {
  const rejectingDatabaseService = {
    getQuery: () => Promise.reject(new Error("unexpected database access")),
    runTransaction: () =>
      Promise.reject(new Error("unexpected database access")),
  } as Partial<DatabaseService> as DatabaseService;

  const services: Array<[string, QuestionnaireResponseService]> = [
    [
      "dietScore",
      new DietScoringQuestionnaireResponseService({
        databaseService: rejectingDatabaseService,
        scoreCalculator: new DietScoreCalculator(),
      }),
    ],
    [
      "heartRisk",
      new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: rejectingDatabaseService,
      }),
    ],
    [
      "heartRisk",
      new HeartRiskNicotineScoringQuestionnaireResponseService({
        databaseService: rejectingDatabaseService,
      }),
    ],
    [
      "nicotineExposure",
      new NicotineScoringQuestionnaireResponseService({
        databaseService: rejectingDatabaseService,
        scoreCalculator: new DefaultNicotineScoreCalculator(),
      }),
    ],
    [
      "who5",
      new Who5ScoringQuestionnaireResponseService({
        databaseService: rejectingDatabaseService,
        scoreCalculator: new DefaultWho5ScoreCalculator(),
      }),
    ],
  ];

  for (const [instrument, service] of services) {
    it(`${service.constructor.name} should ignore malformed ${instrument} canonicals`, async () => {
      for (const canonical of [
        `${surveyUrl}/${instrument}|`,
        `${surveyUrl}/${instrument}|0.0.0|1.0.0`,
        `${surveyUrl}/${instrument}|0.0.0#fragment`,
      ]) {
        const handled = await service.handle(
          testUserId,
          questionnaireResponseDocument(
            "test-response-id",
            new FHIRQuestionnaireResponse({
              id: "test-response",
              authored: new Date(),
              questionnaire: canonical,
              item: [],
            }),
          ),
          { isNew: true },
        );
        expect(handled, canonical).to.equal(false);
      }
    });
  }

  const scoringDatabaseService = {
    getQuery: () => Promise.resolve([]),
    runTransaction: () => Promise.resolve(),
  } as Partial<DatabaseService> as DatabaseService;
  const nicotineScoringService =
    new NicotineScoringQuestionnaireResponseService({
      databaseService: scoringDatabaseService,
      scoreCalculator: new DefaultNicotineScoreCalculator(),
    });
  const neverSmokedAnswer = [
    {
      linkId: "dcb2277e-fe96-4f45-844a-ef58a9516380",
      answer: [
        {
          valueCoding: {
            system: "urn:uuid:049cbbd0-02fa-4fcd-83a7-65a112c1f607",
            code: "never-smoked/vaped",
            display: "Never smoked/vaped",
          },
        },
      ],
    },
  ];

  it("should score a pre-Grove questionnaire response as the shipped app stores it", async () => {
    const id = "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
    const content = preGroveQuestionnaireResponse(
      "nicotineExposure",
      id,
      neverSmokedAnswer,
    );
    expect(content.authored.toISOString()).to.equal("2026-08-28T15:32:00.000Z");

    const handled = await nicotineScoringService.handle(
      testUserId,
      questionnaireResponseDocument(id, content),
      { isNew: true },
    );
    expect(handled).to.equal(true);
  });

  it("should score a Grove questionnaire response as the app stores it", async () => {
    const id = "f4c1e7a2-5b0d-4d8e-9a3f-2c6b1e8d7a90";
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
        system: `${surveyUrl}/nicotineExposure`,
        value: id,
      },
      questionnaire: `${surveyUrl}/nicotineExposure|0.0.0`,
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
      item: neverSmokedAnswer,
    });
    expect(content.authored.toISOString()).to.equal("2026-08-28T15:32:00.000Z");

    const handled = await nicotineScoringService.handle(
      testUserId,
      questionnaireResponseDocument(id, content),
      { isNew: true },
    );
    expect(handled).to.equal(true);
  });
});
