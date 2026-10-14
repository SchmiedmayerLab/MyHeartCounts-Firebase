// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import { describe, it } from "mocha";
import { FHIRQuestionnaireResponse, Score } from "../../../models/index.js";
import {
  DefaultNicotineScoreCalculator,
  NicotineScoringQuestionnaireResponseService,
} from "../../../services/questionnaireResponse/nicotineScoringService.js";

describe("NicotineScoringQuestionnaireResponseService", () => {
  describe("DefaultNicotineScoreCalculator", () => {
    it("should calculate score 0 for never-smoked/vaped", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate("never-smoked/vaped");

      expect(score).to.not.be.null;
      expect(score).to.be.instanceOf(Score);
      expect(score?.overallScore).to.equal(0);
      expect(score?.domainScores.statusScore).to.equal(0);
    });

    it("should calculate score 1 for quit->5-years-ago", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate("quit->5-years-ago");

      expect(score).to.not.be.null;
      expect(score).to.be.instanceOf(Score);
      expect(score?.overallScore).to.equal(1);
      expect(score?.domainScores.statusScore).to.equal(1);
    });

    it("should calculate score 2 for quit-1-5-years-ago", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate("quit-1-5-years-ago");

      expect(score).to.not.be.null;
      expect(score).to.be.instanceOf(Score);
      expect(score?.overallScore).to.equal(2);
      expect(score?.domainScores.statusScore).to.equal(2);
    });

    it("should calculate score 3 for quit-<1-year-ago", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate("quit-<1-year-ago");

      expect(score).to.not.be.null;
      expect(score).to.be.instanceOf(Score);
      expect(score?.overallScore).to.equal(3);
      expect(score?.domainScores.statusScore).to.equal(3);
    });

    it("should calculate score 4 for light-smoker/vaper-(<10/day)", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate("light-smoker/vaper-(<10/day)");

      expect(score).to.not.be.null;
      expect(score).to.be.instanceOf(Score);
      expect(score?.overallScore).to.equal(4);
      expect(score?.domainScores.statusScore).to.equal(4);
    });

    it("should return null for unknown smoking status", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate("Unknown status");

      expect(score).to.be.null;
    });

    it("should calculate score 4 for moderate-smoker/vaper-(10-to-19/day)", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate(
        "moderate-smoker/vaper-(10-to-19/day)",
      );

      expect(score).to.not.be.null;
      expect(score).to.be.instanceOf(Score);
      expect(score?.overallScore).to.equal(4);
      expect(score?.domainScores.statusScore).to.equal(4);
    });

    it("should calculate score 4 for heavy-smoker/vaper-(>20/day)", () => {
      const calculator = new DefaultNicotineScoreCalculator();
      const score = calculator.calculate("heavy-smoker/vaper-(>20/day)");

      expect(score).to.not.be.null;
      expect(score).to.be.instanceOf(Score);
      expect(score?.overallScore).to.equal(4);
      expect(score?.domainScores.statusScore).to.equal(4);
    });
  });

  describe("handle method", () => {
    it("should return false for non-matching questionnaire IDs", async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      const mockDatabaseService = {} as any;
      const mockCalculator = new DefaultNicotineScoreCalculator();

      const service = new NicotineScoringQuestionnaireResponseService({
        databaseService: mockDatabaseService,
        scoreCalculator: mockCalculator,
      });
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire: "non-matching-questionnaire-id",
          item: [],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.false;
    });

    it("should return true for matching questionnaire IDs", async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      const mockDatabaseService = {
        getQuery: () => Promise.resolve([]),
        runTransaction: () => Promise.resolve(),
      } as any;
      const mockCalculator = new DefaultNicotineScoreCalculator();

      const service = new NicotineScoringQuestionnaireResponseService({
        databaseService: mockDatabaseService,
        scoreCalculator: mockCalculator,
      });
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */

      // Create a mock response with the expected structure
      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/nicotineExposure",
          item: [
            {
              linkId: "dcb2277e-fe96-4f45-844a-ef58a9516380",
              answer: [
                {
                  valueCoding: {
                    code: "never-smoked/vaped",
                    display: "Never smoked/vaped",
                    system: "urn:uuid:dd27d607-7d9c-4fa2-e28b-d90a40d628bf",
                  },
                },
              ],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.true;
    });

    it("should return true for a versioned questionnaire canonical", async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      const mockDatabaseService = {
        getQuery: () => Promise.resolve([]),
        runTransaction: () => Promise.resolve(),
      } as any;
      const mockCalculator = new DefaultNicotineScoreCalculator();

      const service = new NicotineScoringQuestionnaireResponseService({
        databaseService: mockDatabaseService,
        scoreCalculator: mockCalculator,
      });
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/nicotineExposure|1.0.0",
          item: [
            {
              linkId: "dcb2277e-fe96-4f45-844a-ef58a9516380",
              answer: [
                {
                  valueCoding: {
                    code: "never-smoked/vaped",
                    display: "Never smoked/vaped",
                    system: "urn:uuid:dd27d607-7d9c-4fa2-e28b-d90a40d628bf",
                  },
                },
              ],
            },
          ],
        }),
      };

      const result = await service.handle("test-user", mockResponse, {
        isNew: true,
      });

      expect(result).to.be.true;
    });

    it("should handle missing smoking status gracefully", async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      const mockDatabaseService = {
        getQuery: () => Promise.resolve([]),
        runTransaction: () => Promise.resolve(),
      } as any;
      const mockCalculator = new DefaultNicotineScoreCalculator();

      const service = new NicotineScoringQuestionnaireResponseService({
        databaseService: mockDatabaseService,
        scoreCalculator: mockCalculator,
      });
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/nicotineExposure",
          item: [
            {
              linkId: "dcb2277e-fe96-4f45-844a-ef58a9516380",
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

    it("should handle database transaction errors gracefully", async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
      const mockDatabaseService = {
        getQuery: () => Promise.resolve([]),
        runTransaction: () => Promise.reject(new Error("Transaction failed")),
      } as any;
      const mockCalculator = new DefaultNicotineScoreCalculator();

      const service = new NicotineScoringQuestionnaireResponseService({
        databaseService: mockDatabaseService,
        scoreCalculator: mockCalculator,
      });
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */

      const mockResponse = {
        id: "test-response-id",
        path: "users/test-user/questionnaireResponses/test-response-id",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          id: "test-response",
          authored: new Date(),
          questionnaire:
            "https://myheartcounts.stanford.edu/fhir/survey/nicotineExposure",
          item: [
            {
              linkId: "dcb2277e-fe96-4f45-844a-ef58a9516380",
              answer: [
                {
                  valueCoding: {
                    code: "never-smoked/vaped",
                    display: "Never smoked/vaped",
                    system: "urn:uuid:dd27d607-7d9c-4fa2-e28b-d90a40d628bf",
                  },
                },
              ],
            },
          ],
        }),
      };

      try {
        await service.handle("test-user", mockResponse, { isNew: true });
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("Transaction failed");
      }
    });
  });
});
