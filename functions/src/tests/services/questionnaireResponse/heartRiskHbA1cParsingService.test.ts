// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { type Firestore } from "firebase-admin/firestore";
import { describe, it } from "mocha";
import {
  CodingSystem,
  type FHIRQuestionnaireResponse,
  FHIRObservationStatus,
  QuantityUnit,
} from "../../../models/index.js";
import { FirestoreService } from "../../../services/database/firestoreService.js";
import { HeartRiskHbA1cParsingQuestionnaireResponseService } from "../../../services/questionnaireResponse/heartRiskHbA1cParsingService.js";
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

const hbA1cItem = (answer: unknown) => ({ linkId: hbA1cLinkId, answer });

const handle = async (id: string, content: FHIRQuestionnaireResponse) => {
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
  const stored = await databaseService.getQuery((collections) =>
    collections.userHealthObservations(testUserId, hbA1cCollection),
  );
  return { handled, stored };
};

const expectStored = async (
  id: string,
  content: FHIRQuestionnaireResponse,
  percent: number,
) => {
  const { handled, stored } = await handle(id, content);
  expect(handled).to.equal(true);
  expect(stored).to.have.length(1);
  const observation = stored[0].content;
  expect(stored[0].id).to.equal(observation.id);
  expect(stored[0].path).to.equal(
    `users/${testUserId}/${hbA1cCollection}/${observation.id}`,
  );
  expect(observation.derivedFrom?.[0].reference).to.equal(
    `QuestionnaireResponse/${id}`,
  );
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
  expect(observation.valueQuantity).to.deep.include(
    QuantityUnit.percent_hba1c.fhirQuantity(percent),
  );
  expect(observation.effectiveDateTime?.toISOString()).to.equal(
    authoredAt.toISOString(),
  );
};

const expectIgnored = async (content: FHIRQuestionnaireResponse) => {
  const { handled, stored } = await handle("r1", content);
  expect(handled).to.equal(false);
  expect(stored).to.have.length(0);
};

describe("HeartRiskHbA1cParsingQuestionnaireResponseService", () => {
  it("ignores other questionnaires", async () => {
    await expectIgnored(
      groveQuestionnaireResponse("who5", "r1", [
        hbA1cItem([{ valueDecimal: 6.5 }]),
      ]),
    );
  });

  it("ignores a response without an HbA1c answer", async () => {
    await expectIgnored(
      groveQuestionnaireResponse("heartRisk", "r1", [hbA1cItem([])]),
    );
  });

  it("ignores a non-numeric HbA1c answer", async () => {
    await expectIgnored(
      groveQuestionnaireResponse("heartRisk", "r1", [
        hbA1cItem([{ valueString: "not a number" }]),
      ]),
    );
    await expectIgnored(
      groveQuestionnaireResponse("heartRisk", "r1", [
        hbA1cItem([{ valueBoolean: true }]),
      ]),
    );
  });

  it("stores a Grove HbA1c answer in % unchanged", async () => {
    const id = "3b0e8d2a-5c4f-4b6d-9e7f-8a9b0c1d2e3f";
    await expectStored(
      id,
      groveQuestionnaireResponse("heartRisk", id, [
        hbA1cItem([
          {
            valueQuantity: {
              value: 6.5,
              unit: "percent",
              system: CodingSystem.ucum,
              code: "%",
            },
          },
        ]),
      ]),
      6.5,
    );
  });

  it("stores a pre-Grove HbA1c answer in % unchanged", async () => {
    const id = "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f";
    await expectStored(
      id,
      preGroveQuestionnaireResponse("heartRisk", id, [
        hbA1cItem([{ valueQuantity: { value: 5.4, unit: "%" } }]),
      ]),
      5.4,
    );
  });

  it("treats integer, decimal and numeric string answers as %", async () => {
    for (const [answer, percent] of [
      [{ valueInteger: 7 }, 7],
      [{ valueDecimal: 6.5 }, 6.5],
      [{ valueString: "5.7" }, 5.7],
    ] as const) {
      await expectStored(
        "r1",
        preGroveQuestionnaireResponse("heartRisk", "r1", [hbA1cItem([answer])]),
        percent,
      );
    }
  });

  it("converts an HbA1c answer given in mmol/mol to %", async () => {
    const id = "7d2f3c0b-4e5a-4f6b-8c9d-1e2f3a4b5c6d";
    const { stored } = await handle(
      id,
      groveQuestionnaireResponse("heartRisk", id, [
        hbA1cItem([
          {
            valueQuantity: {
              value: 48,
              unit: "millimole per mole",
              system: CodingSystem.ucum,
              code: "mmol/mol",
            },
          },
        ]),
      ]),
    );
    // Offset formula, not a factor of 10.
    expect(stored[0].content.valueQuantity?.value).to.be.closeTo(6.54, 0.01);
  });

  it("rethrows database errors", async () => {
    const service = new HeartRiskHbA1cParsingQuestionnaireResponseService({
      databaseService: {
        runTransaction: () => Promise.reject(new Error("Database error")),
      } as unknown as FirestoreService,
    });
    let thrown: unknown;
    try {
      await service.handle(
        testUserId,
        questionnaireResponseDocument(
          "r1",
          groveQuestionnaireResponse("heartRisk", "r1", [
            hbA1cItem([{ valueDecimal: 6.5 }]),
          ]),
        ),
        { isNew: true },
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).to.equal("Database error");
  });
});
