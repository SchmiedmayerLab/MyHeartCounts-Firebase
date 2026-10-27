// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import { Timestamp } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import {
  CodingSystem,
  type FHIRObservation,
  FHIRQuestionnaireResponse,
  fhirQuestionnaireResponseConverter,
} from "../../../models/index.js";
import type { DatabaseService } from "../../../services/database/databaseService.js";
import { HeartRiskLdlParsingQuestionnaireResponseService } from "../../../services/questionnaireResponse/heartRiskLdlParsingService.js";

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

interface WrittenObservation {
  collection: string;
  id: string;
  observation: FHIRObservation;
}

const capturingDatabaseService = (
  written: WrittenObservation[],
): DatabaseService =>
  ({
    runTransaction: (
      run: (collections: unknown, transaction: unknown) => unknown,
    ) =>
      Promise.resolve(
        run(
          {
            userHealthObservations: (_userId: string, collection: string) => ({
              doc: (id: string) => ({ collection, id }),
            }),
          },
          {
            set: (
              ref: { collection: string; id: string },
              observation: FHIRObservation,
            ) => {
              written.push({ ...ref, observation });
            },
          },
        ),
      ),
  }) as unknown as DatabaseService;

const survey = "https://myheartcounts.stanford.edu/fhir/survey";
const ldlLinkId = "1574e238-8804-4a17-fa5e-a764f094bd2b";

const expectLdlObservation = (written: WrittenObservation[], value: number) => {
  expect(written).to.have.length(1);
  const { collection, id, observation } = written[0];
  expect(collection).to.equal(
    "HealthObservations_MHCCustomSampleTypeBloodLipidMeasurement",
  );
  expect(id).to.equal(observation.id);
  expect(observation.code.coding?.map((coding) => coding.system)).to.deep.equal(
    [
      CodingSystem.loinc,
      CodingSystem.mhcSampleType,
      CodingSystem.mhcSampleTypeSuperseded,
    ],
  );
  expect(observation.valueQuantity).to.deep.include({
    value,
    unit: "mg/dL",
    system: CodingSystem.ucum,
    code: "mg/dL",
  });
  expect(observation.effectiveDateTime?.toISOString()).to.equal(
    "2026-08-28T15:32:00.000Z",
  );
};

describe("HeartRiskLdlParsingQuestionnaireResponseService observation shape", () => {
  it("should store the LDL value of a Grove heart risk response", async () => {
    const written: WrittenObservation[] = [];
    const service = new HeartRiskLdlParsingQuestionnaireResponseService({
      databaseService: capturingDatabaseService(written),
    });
    const content = fhirQuestionnaireResponseConverter.value.schema.parse({
      resourceType: "QuestionnaireResponse",
      meta: {
        profile: [
          "https://grovealliance.org/fhir/questionnaire/StructureDefinition/grove-questionnaire-response",
        ],
      },
      identifier: {
        system: `${survey}/heartRisk`,
        value: "2f9d7c1a-4b3e-4a5c-8d6e-7f8a9b0c1d2e",
      },
      language: "en-US",
      questionnaire: `${survey}/heartRisk|0.2.5`,
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
      ],
    });

    const handled = await service.handle(
      "test-user",
      {
        id: "2f9d7c1a-4b3e-4a5c-8d6e-7f8a9b0c1d2e",
        path: "users/test-user/questionnaireResponses/2f9d7c1a-4b3e-4a5c-8d6e-7f8a9b0c1d2e",
        lastUpdate: new Date(),
        content,
      },
      { isNew: true },
    );

    expect(handled).to.be.true;
    expectLdlObservation(written, 132);
  });

  it("should store the LDL value of a pre-Grove heart risk response", async () => {
    const written: WrittenObservation[] = [];
    const service = new HeartRiskLdlParsingQuestionnaireResponseService({
      databaseService: capturingDatabaseService(written),
    });
    const content = fhirQuestionnaireResponseConverter.value.schema.parse({
      resourceType: "QuestionnaireResponse",
      id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      questionnaire: `${survey}/heartRisk`,
      status: "completed",
      authored: Timestamp.fromDate(new Date("2026-08-28T15:32:00.000Z")),
      item: [
        {
          linkId: ldlLinkId,
          answer: [{ valueQuantity: { value: 118, unit: "mg/dL" } }],
        },
      ],
    });

    const handled = await service.handle(
      "test-user",
      {
        id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        path: "users/test-user/questionnaireResponses/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        lastUpdate: new Date(),
        content,
      },
      { isNew: true },
    );

    expect(handled).to.be.true;
    expectLdlObservation(written, 118);
  });
});
