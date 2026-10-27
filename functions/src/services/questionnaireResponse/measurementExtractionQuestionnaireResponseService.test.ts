// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { type QuestionnaireResponse } from "fhir/r4b";
import { FieldPath } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import { ldlObservationCollectionName } from "./ldlObservation.js";
import { MeasurementExtractionQuestionnaireResponseService } from "./measurementExtractionQuestionnaireResponseService.js";
import { onUserQuestionnaireResponseWritten } from "../../functions/onUserQuestionnaireResponseWritten.js";
import {
  FHIRQuestionnaireResponse,
  fhirQuestionnaireResponseConverter,
  healthStatsManualEntrySourceId,
} from "../../models/index.js";
import {
  describeWithEmulators,
  type EmulatorTestEnvironment,
} from "../../tests/functions/testEnvironment.js";
import {
  type QuestionnaireResponseFixture,
  questionnaireResponseFixture,
} from "../../tests/helpers/questionnaireResponses.js";
import { type Document } from "../database/databaseService.js";
import {
  type ExtractedMeasurement,
  type MeasurementProjection,
} from "../measurementExtraction/questionnaireMeasurementExtractor.js";

const documentFor = (
  response: QuestionnaireResponse,
): Document<FHIRQuestionnaireResponse> => ({
  id: response.id ?? "",
  path: `users/user/questionnaireResponses/${response.id ?? ""}`,
  lastUpdate: new Date(),
  content: fhirQuestionnaireResponseConverter.value.schema.parse(response),
});

const withLipidUnit = (
  fixture: QuestionnaireResponseFixture,
  unit: string,
): QuestionnaireResponse => {
  const response = structuredClone(questionnaireResponseFixture(fixture));
  const quantity = response.item?.[0].answer?.[0].valueQuantity;
  if (quantity === undefined) throw new Error("Unexpected fixture shape.");
  quantity.code = unit;
  quantity.unit = unit;
  return response;
};

const recordingProjection = () => {
  const projected: ExtractedMeasurement[][] = [];
  const projection: MeasurementProjection = {
    project: (_userId, measurements) => {
      projected.push(measurements);
      return Promise.resolve();
    },
  };
  return { projection, projected };
};

describe("MeasurementExtractionQuestionnaireResponseService", () => {
  it("ignores questionnaires without an instrument", async () => {
    const { projection, projected } = recordingProjection();
    const service = new MeasurementExtractionQuestionnaireResponseService({
      projections: [projection],
    });
    const response = structuredClone(
      questionnaireResponseFixture("bmi-direct"),
    );
    response.questionnaire =
      "https://myheartcounts.stanford.edu/fhir/survey/who5";
    const handled = await service.handle("user", documentFor(response), {
      isNew: true,
    });
    expect(handled).to.equal(false);
    expect(projected).to.deep.equal([]);
  });

  it("ignores decoded responses without a source resource", async () => {
    const { projection, projected } = recordingProjection();
    const service = new MeasurementExtractionQuestionnaireResponseService({
      projections: [projection],
    });
    const handled = await service.handle(
      "user",
      {
        id: "in-code",
        path: "users/user/questionnaireResponses/in-code",
        lastUpdate: new Date(),
        content: new FHIRQuestionnaireResponse({
          authored: new Date(),
          questionnaire: "https://myheartcounts.stanford.edu/fhir/survey/bmi",
        }),
      },
      { isNew: true },
    );
    expect(handled).to.equal(false);
    expect(projected).to.deep.equal([]);
  });

  it("hands extracted measurements to every projection", async () => {
    const first = recordingProjection();
    const second = recordingProjection();
    const service = new MeasurementExtractionQuestionnaireResponseService({
      projections: [first.projection, second.projection],
    });
    const handled = await service.handle(
      "user",
      documentFor(questionnaireResponseFixture("blood-pressure")),
      { isNew: true },
    );
    expect(handled).to.equal(true);
    expect(first.projected).to.have.length(1);
    expect(first.projected[0][0].measurement.id).to.equal("blood-pressure");
    expect(second.projected).to.deep.equal(first.projected);
  });

  it("does not project when every measurement is refused", async () => {
    const { projection, projected } = recordingProjection();
    const service = new MeasurementExtractionQuestionnaireResponseService({
      projections: [projection],
    });
    const handled = await service.handle(
      "user",
      documentFor(questionnaireResponseFixture("blood-lipids-1")),
      { isNew: true },
    );
    expect(handled).to.equal(false);
    expect(projected).to.deep.equal([]);
  });
});

const userId = "measurement-user";

const writeThroughTrigger = async (
  env: EmulatorTestEnvironment,
  response: QuestionnaireResponse,
  before?: QuestionnaireResponse,
) => {
  const questionnaireResponseId = response.id ?? "";
  const wrapped = env.wrapTrigger(onUserQuestionnaireResponseWritten);
  await wrapped({
    params: { userId, questionnaireResponseId },
    data: env.createChange(
      `users/${userId}/questionnaireResponses/${questionnaireResponseId}`,
      before as unknown as Record<string, unknown> | undefined,
      response as unknown as Record<string, unknown>,
    ),
  });
};

const monthDocument = (env: EmulatorTestEnvironment, metric: string) =>
  env.firestore.doc(`users/${userId}/stats/${metric}/months/2026-09`).get();

const manualEntries = async (env: EmulatorTestEnvironment, metric: string) =>
  (await monthDocument(env, metric)).get(
    new FieldPath("samples", healthStatsManualEntrySourceId),
  ) as unknown;

describeWithEmulators(
  "function: onUserQuestionnaireResponseWritten (measurements)",
  (env) => {
    it("materializes a blood pressure response into the stats document", async () => {
      await writeThroughTrigger(
        env,
        questionnaireResponseFixture("blood-pressure"),
      );
      const document = await env.firestore
        .doc(`users/${userId}/stats/blood-pressure/months/2026-09`)
        .get();
      expect(document.data()).to.deep.equal({
        version: 0,
        metric: "blood-pressure",
        samples: {
          [healthStatsManualEntrySourceId]: [
            {
              id: "B8C989D4-78FC-4CD8-985E-912E479FB631",
              date: "2026-09-01T13:21:10+02:00",
              systolic: 69,
              diastolic: 69,
              unit: "mmHg",
            },
          ],
        },
      });
    });

    it("is idempotent when the same response is written again", async () => {
      const response = questionnaireResponseFixture("bmi-direct");
      await writeThroughTrigger(env, response);
      await writeThroughTrigger(env, response, response);
      expect(await manualEntries(env, "bmi")).to.deep.equal([
        {
          id: "4A075C57-7392-4FA8-AF6B-2A62764360FF",
          date: "2026-09-01T15:42:35+02:00",
          value: 25,
          unit: "count",
        },
      ]);
    });

    it("writes blood lipids to the stats document and the LDL observations", async () => {
      await writeThroughTrigger(env, withLipidUnit("blood-lipids-2", "mg/dL"));
      expect(await manualEntries(env, "blood-lipids")).to.deep.equal([
        {
          id: "04E36106-80BF-4698-B2B3-1D3FFD903459",
          date: "2026-09-01T13:25:22+02:00",
          value: 123,
          unit: "mg/dL",
        },
      ]);
      const observations = await env.firestore
        .collection(`users/${userId}/${ldlObservationCollectionName}`)
        .get();
      expect(observations.size).to.equal(1);
      expect(observations.docs[0].get("valueQuantity.value")).to.equal(123);
      expect(observations.docs[0].get("derivedFrom")).to.deep.equal([
        {
          reference:
            "QuestionnaireResponse/04E36106-80BF-4698-B2B3-1D3FFD903459",
        },
      ]);
    });

    it("writes nothing for a blood lipids response with a refused unit", async () => {
      await writeThroughTrigger(
        env,
        questionnaireResponseFixture("blood-lipids-1"),
      );
      expect((await monthDocument(env, "blood-lipids")).exists).to.equal(false);
      const observations = await env.firestore
        .collection(`users/${userId}/${ldlObservationCollectionName}`)
        .get();
      expect(observations.size).to.equal(0);
    });
  },
);
