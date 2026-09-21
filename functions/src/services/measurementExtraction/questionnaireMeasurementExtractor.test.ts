// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import {
  type QuestionnaireResponse,
  type QuestionnaireResponseItemAnswer,
} from "fhir/r4b";
import { describe, it } from "mocha";
import {
  type Instrument,
  instrumentForQuestionnaire,
} from "./instrumentRegistry.js";
import {
  type ExtractedMeasurement,
  extractMeasurements,
} from "./questionnaireMeasurementExtractor.js";
import { fhirQuestionnaireResponseConverter } from "../../models/index.js";
import {
  type QuestionnaireResponseFixture,
  questionnaireResponseFixture,
} from "../../tests/helpers/questionnaireResponses.js";

const extract = (
  response: QuestionnaireResponse,
  instrument = instrumentForQuestionnaire(response.questionnaire ?? ""),
) => {
  if (instrument === undefined) throw new Error("No instrument for fixture.");
  return extractMeasurements(response, response.id ?? "", instrument);
};

const singleMeasurement = (
  fixture: QuestionnaireResponseFixture,
): ExtractedMeasurement => {
  const { measurements, refusals } = extract(
    questionnaireResponseFixture(fixture),
  );
  expect(refusals).to.deep.equal([]);
  expect(measurements).to.have.length(1);
  return measurements[0];
};

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

describe("extractMeasurements", () => {
  it("extracts a blood pressure panel with both components", () => {
    const measurement = singleMeasurement("blood-pressure");
    expect(measurement.kind).to.equal("components");
    if (measurement.kind !== "components") return;
    expect(measurement.measurement.id).to.equal("blood-pressure");
    expect(measurement.components.systolic).to.deep.equal({
      value: 69,
      quantity: { code: "mm[Hg]", unit: "mmHg" },
    });
    expect(measurement.components.diastolic?.value).to.equal(69);
    expect(measurement.questionnaireResponseId).to.equal(
      "B8C989D4-78FC-4CD8-985E-912E479FB631",
    );
    expect(measurement.effective.toISO()).to.equal(
      "2026-09-01T13:21:10.000+02:00",
    );
    expect(measurement.effective.offset).to.equal(120);
  });

  it("refuses a blood lipids answer whose unit is not mg/dL", () => {
    const { measurements, refusals } = extract(
      questionnaireResponseFixture("blood-lipids-1"),
    );
    expect(measurements).to.deep.equal([]);
    expect(refusals).to.have.length(1);
    expect(refusals[0]).to.contain("mL/dL");
  });

  it("extracts LDL cholesterol once the unit is mg/dL", () => {
    const { measurements, refusals } = extract(
      withLipidUnit("blood-lipids-2", "mg/dL"),
    );
    expect(refusals).to.deep.equal([]);
    expect(measurements).to.have.length(1);
    const measurement = measurements[0];
    expect(measurement.kind).to.equal("quantity");
    if (measurement.kind !== "quantity") return;
    expect(measurement.measurement.id).to.equal("ldl-cholesterol");
    expect(measurement.value).to.deep.equal({
      value: 123,
      quantity: { code: "mg/dL", unit: "mg/dL" },
    });
  });

  it("extracts fasting blood glucose", () => {
    const measurement = singleMeasurement("blood-glucose-fasting");
    if (measurement.kind !== "quantity") expect.fail("expected a quantity");
    expect(measurement.measurement.id).to.equal(
      "blood-glucose-unspecified-specimen",
    );
    expect(measurement.value.value).to.equal(50);
  });

  it("extracts a directly entered BMI using the declared unit", () => {
    const measurement = singleMeasurement("bmi-direct");
    if (measurement.kind !== "quantity") expect.fail("expected a quantity");
    expect(measurement.measurement.id).to.equal("body-mass-index");
    expect(measurement.value).to.deep.equal({
      value: 25,
      quantity: { code: "kg/m2", unit: "kg/m2" },
    });
  });

  it("extracts only the BMI from a computed entry by default", () => {
    const measurement = singleMeasurement("bmi-compute");
    if (measurement.kind !== "quantity") expect.fail("expected a quantity");
    expect(measurement.measurement.id).to.equal("body-mass-index");
    expect(measurement.value.value).to.equal(12.839108466748712);
  });

  it("extracts height and weight from a computed entry when declared", () => {
    const instrument: Instrument = {
      questionnaire: "https://myheartcounts.stanford.edu/fhir/survey/bmi",
      extractions: [
        { kind: "quantity", measurement: "body-mass-index", linkId: "bmi" },
        { kind: "quantity", measurement: "body-height", linkId: "height" },
        { kind: "quantity", measurement: "body-weight", linkId: "weight" },
      ],
    };
    const { measurements, refusals } = extract(
      questionnaireResponseFixture("bmi-compute"),
      instrument,
    );
    expect(refusals).to.deep.equal([]);
    expect(
      measurements.map((measurement) =>
        measurement.kind === "quantity" ?
          [measurement.measurement.id, measurement.value.value]
        : [],
      ),
    ).to.deep.equal([
      ["body-mass-index", 12.839108466748712],
      ["body-height", 187.95999999999998],
      ["body-weight", 45.35923699999997],
    ]);
  });

  it("refuses a computed entry when a declared measurement is missing", () => {
    const instrument: Instrument = {
      questionnaire: "https://myheartcounts.stanford.edu/fhir/survey/bmi",
      extractions: [
        { kind: "quantity", measurement: "body-mass-index", linkId: "bmi" },
        { kind: "quantity", measurement: "body-height", linkId: "height" },
      ],
    };
    const { measurements, refusals } = extract(
      questionnaireResponseFixture("bmi-direct"),
      instrument,
    );
    expect(measurements).to.have.length(1);
    expect(refusals).to.have.length(1);
    expect(refusals[0]).to.contain("body-height");
  });

  it("ignores responses that are not completed or amended", () => {
    const response = structuredClone(
      questionnaireResponseFixture("blood-pressure"),
    );
    response.status = "in-progress";
    const { measurements, refusals } = extract(response);
    expect(measurements).to.deep.equal([]);
    expect(refusals[0]).to.contain("in-progress");
  });

  it("refuses responses without a valid authored time", () => {
    const response = structuredClone(
      questionnaireResponseFixture("blood-pressure"),
    );
    delete response.authored;
    expect(extract(response).measurements).to.deep.equal([]);
    response.authored = "yesterday";
    expect(extract(response).measurements).to.deep.equal([]);
  });

  it("resolves instruments from versioned questionnaire canonicals", () => {
    expect(
      instrumentForQuestionnaire(
        "https://myheartcounts.stanford.edu/fhir/survey/bmi|1.0.0",
      )?.questionnaire,
    ).to.equal("https://myheartcounts.stanford.edu/fhir/survey/bmi");
    expect(
      instrumentForQuestionnaire(
        "https://myheartcounts.stanford.edu/fhir/survey/who5",
      ),
    ).to.equal(undefined);
  });
});

describe("extractMeasurements edge cases", () => {
  const glucose = (
    mutate: (answer: QuestionnaireResponseItemAnswer) => void,
  ): QuestionnaireResponse => {
    const response = structuredClone(
      questionnaireResponseFixture("blood-glucose-fasting"),
    );
    const answer = response.item?.[0].answer?.[0];
    if (answer === undefined) throw new Error("Unexpected fixture shape.");
    mutate(answer);
    return response;
  };

  it("accepts unit text matching the declared display when no code is present", () => {
    const response = structuredClone(
      questionnaireResponseFixture("blood-pressure"),
    );
    for (const item of response.item?.[0].item ?? []) {
      const quantity = item.answer?.[0].valueQuantity;
      delete quantity?.code;
      delete quantity?.system;
    }
    const { measurements, refusals } = extract(response);
    expect(refusals).to.deep.equal([]);
    expect(measurements).to.have.length(1);
  });

  it("accepts a bare value under the declared unit", () => {
    const { measurements } = extract(
      glucose((answer) => {
        delete answer.valueQuantity?.code;
        delete answer.valueQuantity?.system;
        delete answer.valueQuantity?.unit;
      }),
    );
    expect(measurements).to.have.length(1);
  });

  it("refuses unit text that does not match the declared unit", () => {
    const { refusals } = extract(
      glucose((answer) => {
        delete answer.valueQuantity?.code;
        delete answer.valueQuantity?.system;
        answer.valueQuantity = { ...answer.valueQuantity, unit: "mmol/L" };
      }),
    );
    expect(refusals).to.have.length(1);
  });

  it("refuses coded units from another system", () => {
    const { refusals } = extract(
      glucose((answer) => {
        answer.valueQuantity = {
          ...answer.valueQuantity,
          system: "http://example.org/units",
        };
      }),
    );
    expect(refusals).to.have.length(1);
  });

  it("refuses quantities without a numeric value", () => {
    const { refusals } = extract(
      glucose((answer) => delete answer.valueQuantity?.value),
    );
    expect(refusals[0]).to.contain("no numeric value");
  });

  it("extracts integer answers under the declared unit", () => {
    const { measurements } = extract(
      glucose((answer) => {
        delete answer.valueQuantity;
        answer.valueInteger = 55;
      }),
    );
    expect(measurements).to.have.length(1);
    if (measurements[0].kind !== "quantity") expect.fail("expected a quantity");
    expect(measurements[0].value.value).to.equal(55);
  });

  it("refuses answers without a numeric representation", () => {
    const { refusals } = extract(
      glucose((answer) => {
        delete answer.valueQuantity;
        answer.valueString = "high";
      }),
    );
    expect(refusals[0]).to.contain("no quantity, decimal, or integer");
  });

  it("refuses items with multiple answers", () => {
    const response = structuredClone(
      questionnaireResponseFixture("blood-glucose-fasting"),
    );
    response.item?.[0].answer?.push({ valueDecimal: 51 });
    expect(extract(response).refusals[0]).to.contain("found 2");
  });

  it("refuses duplicated items", () => {
    const response = structuredClone(
      questionnaireResponseFixture("blood-glucose-fasting"),
    );
    response.item?.push(structuredClone(response.item[0]));
    expect(extract(response).refusals[0]).to.contain("found 2");
  });

  it("finds items nested under a parent answer", () => {
    const response = structuredClone(
      questionnaireResponseFixture("bmi-direct"),
    );
    const [mode, entered, bmi] = response.item ?? [];
    const modeAnswer = mode.answer?.[0];
    if (modeAnswer === undefined) throw new Error("Unexpected fixture shape.");
    modeAnswer.item = [bmi];
    response.item = [mode, entered];
    const { measurements, refusals } = extract(response);
    expect(refusals).to.deep.equal([]);
    expect(measurements).to.have.length(1);
  });

  it("refuses component panels without a declared linkId", () => {
    const { refusals } = extract(
      questionnaireResponseFixture("blood-pressure"),
      {
        questionnaire:
          "https://myheartcounts.stanford.edu/fhir/survey/blood-pressure",
        extractions: [
          {
            kind: "components",
            measurement: "blood-pressure",
            linkIds: { systolic: "blood-pressure-systolic" },
          },
        ],
      },
    );
    expect(refusals[0]).to.contain("diastolic");
  });

  it("accepts authored values decoded as dates or timestamps", () => {
    const asAuthored = (value: unknown): string => value as string;
    const measured = (authored: string) => {
      const response = structuredClone(
        questionnaireResponseFixture("blood-glucose-fasting"),
      );
      response.authored = authored;
      return extract(response);
    };
    const fromDate = measured(
      asAuthored(new Date("2026-09-01T11:26:51Z")),
    ).measurements;
    expect(fromDate[0]?.effective.toISO()).to.equal("2026-09-01T11:26:51.000Z");
    const fromTimestamp = measured(
      asAuthored({ toDate: () => new Date("2026-09-01T11:26:51Z") }),
    ).measurements;
    expect(fromTimestamp[0]?.effective.toISO()).to.equal(
      "2026-09-01T11:26:51.000Z",
    );
    expect(
      measured(asAuthored({ toDate: () => "nope" })).measurements,
    ).to.deep.equal([]);
    expect(measured(asAuthored(42)).measurements).to.deep.equal([]);
  });
});

describe("fhirQuestionnaireResponseConverter", () => {
  it("keeps the source resource as value", () => {
    const fixture = questionnaireResponseFixture("bmi-compute");
    const decoded =
      fhirQuestionnaireResponseConverter.value.schema.parse(fixture);
    expect(decoded.value).to.deep.equal(fixture);
    expect(decoded.authored).to.be.instanceOf(Date);
    expect(decoded.authored.toISOString()).to.equal("2026-09-01T13:43:05.693Z");
    expect(decoded.questionnaire).to.equal(fixture.questionnaire);
  });

  it("still rejects documents that do not decode", () => {
    expect(() =>
      fhirQuestionnaireResponseConverter.value.schema.parse({ authored: 1 }),
    ).to.throw();
  });
});
