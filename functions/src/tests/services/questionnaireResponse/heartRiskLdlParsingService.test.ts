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
  FHIRQuestionnaireResponse,
  QuantityUnit,
} from "../../../models/index.js";
import { FirestoreService } from "../../../services/database/firestoreService.js";
import { HeartRiskLdlParsingQuestionnaireResponseService } from "../../../services/questionnaireResponse/heartRiskLdlParsingService.js";
import {
  authoredAt,
  groveQuestionnaireResponse,
  preGroveQuestionnaireResponse,
  questionnaireResponseDocument,
  testUserId,
} from "../../helpers/questionnaireResponses.js";
import { MockFirestore } from "../../mocks/firestore.js";

describe("HeartRiskLdlParsingQuestionnaireResponseService", () => {
  describe("handle method", () => {
    it("should return false for non-matching questionnaire URLs", async () => {
      const mockDatabaseService = {} as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire: "non-matching-questionnaire-url",
          item: [],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.false;
    });

    it("should return false when no LDL value is found", async () => {
      const mockDatabaseService = {} as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "different-question-id",
              answer: [{ valueString: "some value" }],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.false;
    });

    it("should return false when LDL question has no answer", async () => {
      const mockDatabaseService = {} as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "1574e238-8804-4a17-fa5e-a764f094bd2b",
              answer: [],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.false;
    });

    it("should return true and store observation for valueInteger", async () => {
      const mockDatabaseService = {
        runTransaction: () => Promise.resolve(),
      } as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "1574e238-8804-4a17-fa5e-a764f094bd2b",
              answer: [{ valueInteger: 120 }],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.true;
    });

    it("should return true and store observation for valueDecimal", async () => {
      const mockDatabaseService = {
        runTransaction: () => Promise.resolve(),
      } as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "1574e238-8804-4a17-fa5e-a764f094bd2b",
              answer: [{ valueDecimal: 125.5 }],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.true;
    });

    it("should return true and store observation for valid valueString", async () => {
      const mockDatabaseService = {
        runTransaction: () => Promise.resolve(),
      } as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "1574e238-8804-4a17-fa5e-a764f094bd2b",
              answer: [{ valueString: "130.75" }],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.true;
    });

    it("should return false for non-numeric valueString", async () => {
      const mockDatabaseService = {} as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "1574e238-8804-4a17-fa5e-a764f094bd2b",
              answer: [{ valueString: "not a number" }],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.false;
    });

    it("should return false when answer has no numeric value type", async () => {
      const mockDatabaseService = {} as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "1574e238-8804-4a17-fa5e-a764f094bd2b",
              answer: [{ valueBoolean: true }],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.false;
    });

    it("should handle errors gracefully and rethrow", async () => {
      const mockDatabaseService = {
        runTransaction: () => Promise.reject(new Error("Database error")),
      } as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          item: [
            {
              linkId: "1574e238-8804-4a17-fa5e-a764f094bd2b",
              answer: [{ valueInteger: 120 }],
            },
          ],
        }),
      };

      try {
        await service.handle("test-user", mockResponse, { isNew: true });
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("Database error");
      }
    });

    it("should handle extraction errors and return false", async () => {
      const mockDatabaseService = {} as any;

      const service = new HeartRiskLdlParsingQuestionnaireResponseService({
        databaseService: mockDatabaseService,
      });

      // Create a response with a malformed content that will cause an error during extraction
      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: {
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/heartRisk",
          leafResponseItem: () => {
            throw new Error("Extraction error");
          },
        } as any,
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.false;
    });
  });
});

const ldlLinkId = "1574e238-8804-4a17-fa5e-a764f094bd2b";
const ldlCollection =
  "HealthObservations_MHCCustomSampleTypeBloodLipidMeasurement";

const storeLdlObservation = async (
  id: string,
  content: FHIRQuestionnaireResponse,
): Promise<FHIRObservation> => {
  const databaseService = new FirestoreService(
    new MockFirestore() as unknown as Firestore,
  );
  const service = new HeartRiskLdlParsingQuestionnaireResponseService({
    databaseService,
  });
  const handled = await service.handle(
    testUserId,
    questionnaireResponseDocument(id, content),
    { isNew: true },
  );
  expect(handled).to.equal(true);

  const stored = await databaseService.getQuery((collections) =>
    collections.userHealthObservations(testUserId, ldlCollection),
  );
  expect(stored).to.have.length(1);
  expect(stored[0].path).to.equal(
    `users/${testUserId}/${ldlCollection}/${stored[0].content.id}`,
  );
  expect(stored[0].content.derivedFrom?.[0].reference).to.equal(
    `QuestionnaireResponse/${id}`,
  );
  return stored[0].content;
};

const expectLdlObservation = (observation: FHIRObservation, value: number) => {
  expect(
    observation.code.coding?.map(({ system, code, display }) => ({
      system,
      code,
      display,
    })),
  ).to.deep.equal([
    { system: CodingSystem.loinc, code: "18262-6", display: undefined },
    {
      system: CodingSystem.mhcSampleType,
      code: "MHCCustomSampleTypeBloodLipidMeasurement",
      display: "LDL Cholesterol",
    },
    {
      system: CodingSystem.mhcSampleTypeSuperseded,
      code: "MHCCustomSampleTypeBloodLipidMeasurement",
      display: "LDL Cholesterol",
    },
  ]);
  expect(observation.valueQuantity).to.deep.include(
    QuantityUnit.mg_dL.fhirQuantity(value),
  );
  expect(observation.effectiveDateTime?.toISOString()).to.equal(
    authoredAt.toISOString(),
  );
};

describe("HeartRiskLdlParsingQuestionnaireResponseService observation shape", () => {
  it("should store a Grove LDL answer as an observation both app generations read", async () => {
    const id = "2f9d7c1a-4b3e-4a5c-8d6e-7f8a9b0c1d2e";
    const content = groveQuestionnaireResponse("heartRisk", id, [
      {
        linkId: ldlLinkId,
        answer: [
          {
            valueQuantity: {
              value: 132,
              unit: "milligram per deciliter",
              system: CodingSystem.ucum,
              code: "mg/dL",
            },
          },
        ],
      },
    ]);
    expectLdlObservation(await storeLdlObservation(id, content), 132);
  });

  it("should store a pre-Grove LDL answer as an observation both app generations read", async () => {
    const id = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const content = preGroveQuestionnaireResponse("heartRisk", id, [
      {
        linkId: ldlLinkId,
        answer: [{ valueQuantity: { value: 118, unit: "mg/dL" } }],
      },
    ]);
    expectLdlObservation(await storeLdlObservation(id, content), 118);
  });
});
