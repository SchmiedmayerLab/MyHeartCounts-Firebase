// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import { type Firestore } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import {
  CodingSystem,
  type FHIRObservation,
  FHIRObservationStatus,
  FHIRQuestionnaireResponse,
} from "../../../models/index.js";
import { FirestoreService } from "../../../services/database/firestoreService.js";
import {
  HeartRiskHbA1cParsingQuestionnaireResponseService,
  hbA1cPercentFromMmolPerMol,
} from "../../../services/questionnaireResponse/heartRiskHbA1cParsingService.js";
import {
  authoredAt,
  groveQuestionnaireResponse,
  preGroveQuestionnaireResponse,
  questionnaireResponseDocument,
  testUserId,
} from "../../helpers/questionnaireResponses.js";
import { MockFirestore } from "../../mocks/firestore.js";

const hbA1cLinkId = "ad91308f-3d7c-407e-b4eb-6dcbfade7497";
const hbA1cCollection = "HealthObservations_MHCCustomSampleTypeBloodGlucoseA1c";
const heartRiskUrl = "https://myheartcounts.stanford.edu/fhir/survey/heartRisk";

const mockResponse = (questionnaire: string, item: unknown[]) => ({
  id: "test-response-id",
  path: "users/test-user/questionnaireResponses/test-response-id",
  lastUpdate: new Date(),
  content: new FHIRQuestionnaireResponse({
    id: "test-response",
    authored: new Date(),
    questionnaire,
    item: item as any,
  }),
});

describe("HeartRiskHbA1cParsingQuestionnaireResponseService", () => {
  describe("handle method", () => {
    it("should return false for non-matching questionnaire URLs", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: {} as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse("https://myheartcounts.stanford.edu/fhir/survey/who5", [
          { linkId: hbA1cLinkId, answer: [{ valueDecimal: 6.5 }] },
        ]),
        { isNew: true },
      );

      expect(result).to.be.false;
    });

    it("should return false when no HbA1c value is found", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: {} as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse(heartRiskUrl, [
          {
            linkId: "different-question-id",
            answer: [{ valueString: "some value" }],
          },
        ]),
        { isNew: true },
      );

      expect(result).to.be.false;
    });

    it("should return false when HbA1c question has no answer", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: {} as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse(heartRiskUrl, [{ linkId: hbA1cLinkId, answer: [] }]),
        { isNew: true },
      );

      expect(result).to.be.false;
    });

    it("should return true and store observation for valueInteger", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: { runTransaction: () => Promise.resolve() } as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse(heartRiskUrl, [
          { linkId: hbA1cLinkId, answer: [{ valueInteger: 7 }] },
        ]),
        { isNew: true },
      );

      expect(result).to.be.true;
    });

    it("should return true and store observation for valueDecimal", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: { runTransaction: () => Promise.resolve() } as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse(heartRiskUrl, [
          { linkId: hbA1cLinkId, answer: [{ valueDecimal: 6.5 }] },
        ]),
        { isNew: true },
      );

      expect(result).to.be.true;
    });

    it("should return true and store observation for valid valueString", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: { runTransaction: () => Promise.resolve() } as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse(heartRiskUrl, [
          { linkId: hbA1cLinkId, answer: [{ valueString: "5.7" }] },
        ]),
        { isNew: true },
      );

      expect(result).to.be.true;
    });

    it("should return false for non-numeric valueString", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: {} as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse(heartRiskUrl, [
          { linkId: hbA1cLinkId, answer: [{ valueString: "not a number" }] },
        ]),
        { isNew: true },
      );

      expect(result).to.be.false;
    });

    it("should return false when answer has no numeric value type", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: {} as any,
      });

      const result = await service.handle(
        "test-user",
        mockResponse(heartRiskUrl, [
          { linkId: hbA1cLinkId, answer: [{ valueBoolean: true }] },
        ]),
        { isNew: true },
      );

      expect(result).to.be.false;
    });

    it("should handle errors gracefully and rethrow", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: {
          runTransaction: () => Promise.reject(new Error("Database error")),
        } as any,
      });

      try {
        await service.handle(
          "test-user",
          mockResponse(heartRiskUrl, [
            { linkId: hbA1cLinkId, answer: [{ valueDecimal: 6.5 }] },
          ]),
          { isNew: true },
        );
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("Database error");
      }
    });

    it("should handle extraction errors and return false", async () => {
      const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
        databaseService: {} as any,
      });

      // Malformed content that makes extraction throw.
      const result = await service.handle(
        "test-user",
        {
          id: "test-response-id",
          path: "users/test-user/questionnaireResponses/test-response-id",
          lastUpdate: new Date(),
          content: {
            questionnaire: heartRiskUrl,
            leafResponseItem: () => {
              throw new Error("Extraction error");
            },
          } as any,
        },
        { isNew: true },
      );

      expect(result).to.be.false;
    });
  });
});

describe("hbA1cPercentFromMmolPerMol", () => {
  it("should apply the offset formula, not a factor of 10", () => {
    expect(hbA1cPercentFromMmolPerMol(48)).to.be.closeTo(6.542, 0.001);
    expect(hbA1cPercentFromMmolPerMol(42)).to.be.closeTo(5.993, 0.001);
    expect(hbA1cPercentFromMmolPerMol(53)).to.be.closeTo(6.999, 0.001);
  });
});

const storeHbA1cObservation = async (
  id: string,
  content: FHIRQuestionnaireResponse,
): Promise<FHIRObservation> => {
  const databaseService = new FirestoreService(
    new MockFirestore() as unknown as Firestore,
  );
  const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
    databaseService,
  });
  const handled = await service.handle(
    testUserId,
    questionnaireResponseDocument(id, content),
    { isNew: true },
  );
  expect(handled).to.equal(true);

  const stored = await databaseService.getQuery((collections) =>
    collections.userHealthObservations(testUserId, hbA1cCollection),
  );
  expect(stored).to.have.length(1);
  expect(stored[0].id).to.equal(stored[0].content.id);
  expect(stored[0].path).to.equal(
    `users/${testUserId}/${hbA1cCollection}/${stored[0].content.id}`,
  );
  expect(stored[0].content.derivedFrom?.[0].reference).to.equal(
    `QuestionnaireResponse/${id}`,
  );
  return stored[0].content;
};

const expectHbA1cObservation = (
  observation: FHIRObservation,
  percent: number,
) => {
  expect(observation.status).to.equal(FHIRObservationStatus.final);
  expect(
    observation.code.coding?.map(({ system, code, display }) => ({
      system,
      code,
      display,
    })),
  ).to.deep.equal([
    {
      system: CodingSystem.loinc,
      code: "4548-4",
      display: "Hemoglobin A1c/Hemoglobin.total in Blood",
    },
    {
      system: CodingSystem.mhcSampleType,
      code: "MHCCustomSampleTypeBloodGlucoseA1c",
      display: "Hemoglobin A1c",
    },
    {
      system: CodingSystem.mhcSampleTypeSuperseded,
      code: "MHCCustomSampleTypeBloodGlucoseA1c",
      display: "Hemoglobin A1c",
    },
  ]);
  expect(observation.valueQuantity?.system).to.equal(
    "http://unitsofmeasure.org",
  );
  expect(observation.valueQuantity?.code).to.equal("%");
  expect(observation.valueQuantity?.unit).to.equal("%");
  expect(observation.valueQuantity?.value).to.be.closeTo(percent, 1e-9);
  expect(observation.effectiveDateTime?.toISOString()).to.equal(
    authoredAt.toISOString(),
  );
};

describe("HeartRiskHbA1cParsingQuestionnaireResponseService observation shape", () => {
  it("should store a Grove HbA1c answer in % unchanged", async () => {
    const id = "3b0e8d2a-5c4f-4b6d-9e7f-8a9b0c1d2e3f";
    const content = groveQuestionnaireResponse("heartRisk", id, [
      {
        linkId: hbA1cLinkId,
        answer: [
          {
            valueQuantity: {
              value: 6.5,
              unit: "percent",
              system: CodingSystem.ucum,
              code: "%",
            },
          },
        ],
      },
    ]);
    const observation = await storeHbA1cObservation(id, content);
    expectHbA1cObservation(observation, 6.5);
    expect(observation.valueQuantity?.value).to.equal(6.5);
  });

  it("should store a pre-Grove HbA1c answer in % unchanged", async () => {
    const id = "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f";
    const content = preGroveQuestionnaireResponse("heartRisk", id, [
      {
        linkId: hbA1cLinkId,
        answer: [{ valueQuantity: { value: 5.4, unit: "%" } }],
      },
    ]);
    expectHbA1cObservation(await storeHbA1cObservation(id, content), 5.4);
  });

  it("should convert an HbA1c answer given in mmol/mol to %", async () => {
    const id = "7d2f3c0b-4e5a-4f6b-8c9d-1e2f3a4b5c6d";
    const content = groveQuestionnaireResponse("heartRisk", id, [
      {
        linkId: hbA1cLinkId,
        answer: [
          {
            valueQuantity: {
              value: 48,
              unit: "millimole per mole",
              system: CodingSystem.ucum,
              code: "mmol/mol",
            },
          },
        ],
      },
    ]);
    const observation = await storeHbA1cObservation(id, content);
    expectHbA1cObservation(observation, 48 / 10.929 + 2.15);
    expect(observation.valueQuantity?.value).to.be.closeTo(6.54, 0.01);
  });
});
