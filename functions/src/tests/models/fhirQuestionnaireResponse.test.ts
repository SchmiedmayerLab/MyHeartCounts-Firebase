// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  CodingSystem,
  fhirQuestionnaireResponseConverter,
} from "../../models/index.js";
import {
  groveQuestionnaireResponse,
  preGroveQuestionnaireResponse,
} from "../helpers/questionnaireResponses.js";

describe("fhirQuestionnaireResponseConverter", () => {
  const linkId = "1574e238-8804-4a17-fa5e-a764f094bd2b";

  it("should keep the coded unit of a quantity answer across a round trip", () => {
    const quantity = {
      value: 3,
      unit: "millimole per litre",
      system: CodingSystem.ucum,
      code: "mmol/L",
    };
    const content = groveQuestionnaireResponse(
      "heartRisk",
      "2f9d7c1a-4b3e-4a5c-8d6e-7f8a9b0c1d2e",
      [{ linkId, answer: [{ valueQuantity: quantity }] }],
    );

    const encoded = fhirQuestionnaireResponseConverter.value.encode(content);
    expect(encoded.item?.[0]?.answer?.[0]?.valueQuantity).to.deep.equal(
      quantity,
    );

    const decoded =
      fhirQuestionnaireResponseConverter.value.schema.parse(encoded);
    expect(
      decoded.leafResponseItem(linkId)?.answer?.[0]?.valueQuantity,
    ).to.deep.equal(quantity);
  });

  it("should encode a pre-Grove quantity answer without adding fields", () => {
    const content = preGroveQuestionnaireResponse(
      "heartRisk",
      "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      [{ linkId, answer: [{ valueQuantity: { value: 118, unit: "mg/dL" } }] }],
    );

    const encoded = fhirQuestionnaireResponseConverter.value.encode(content);
    expect(encoded.item?.[0]?.answer?.[0]?.valueQuantity).to.deep.equal({
      value: 118,
      unit: "mg/dL",
    });
  });

  it("should encode an answer without a quantity as null", () => {
    const content = preGroveQuestionnaireResponse(
      "heartRisk",
      "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      [{ linkId, answer: [{ valueInteger: 120 }] }],
    );

    const encoded = fhirQuestionnaireResponseConverter.value.encode(content);
    expect(encoded.item?.[0]?.answer?.[0]?.valueQuantity).to.equal(null);
    expect(encoded.item?.[0]?.answer?.[0]?.valueInteger).to.equal(120);
  });
});
