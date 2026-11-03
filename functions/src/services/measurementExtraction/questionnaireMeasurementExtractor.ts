// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  type QuestionnaireResponse,
  type QuestionnaireResponseItem,
  type QuestionnaireResponseItemAnswer,
} from "fhir/r4b";
import { DateTime } from "luxon";
import {
  type ComponentsExtraction,
  type Instrument,
  type QuantityExtraction,
} from "./instrumentRegistry.js";
import {
  type ComponentsMeasurement,
  measurementCatalog,
  type QuantityMeasurement,
  type UcumQuantity,
  ucumSystem,
} from "./measurementCatalog.js";

export interface MeasuredQuantity {
  value: number;
  quantity: UcumQuantity;
}

interface ExtractedMeasurementBase {
  questionnaireResponseId: string;
  effective: DateTime;
}

export interface ExtractedQuantityMeasurement extends ExtractedMeasurementBase {
  kind: "quantity";
  measurement: QuantityMeasurement;
  value: MeasuredQuantity;
}

export interface ExtractedComponentsMeasurement extends ExtractedMeasurementBase {
  kind: "components";
  measurement: ComponentsMeasurement;
  components: Partial<Record<string, MeasuredQuantity>>;
}

export type ExtractedMeasurement =
  | ExtractedQuantityMeasurement
  | ExtractedComponentsMeasurement;

export interface MeasurementExtractionResult {
  measurements: ExtractedMeasurement[];
  refusals: string[];
}

export interface MeasurementProjection {
  project(userId: string, measurements: ExtractedMeasurement[]): Promise<void>;
}

class MeasurementRefusal extends Error {
  constructor(message: string) {
    super(message);
    // Required for `instanceof` with the es5 compile target.
    Object.setPrototypeOf(this, MeasurementRefusal.prototype);
  }
}

const usableStatuses: ReadonlySet<string> = new Set(["completed", "amended"]);

export const extractMeasurements = (
  response: QuestionnaireResponse,
  questionnaireResponseId: string,
  instrument: Instrument,
): MeasurementExtractionResult => {
  if (!usableStatuses.has(response.status)) {
    return {
      measurements: [],
      refusals: [`status '${response.status}' is not usable`],
    };
  }
  const effective = parseEffective(response.authored);
  if (effective === undefined) {
    return {
      measurements: [],
      refusals: ["authored is missing or not a valid dateTime"],
    };
  }

  const measurements: ExtractedMeasurement[] = [];
  const refusals: string[] = [];
  for (const extraction of instrument.extractions) {
    try {
      measurements.push(
        extraction.kind === "quantity" ?
          {
            ...extractQuantity(response, extraction),
            questionnaireResponseId,
            effective,
          }
        : {
            ...extractComponents(response, extraction),
            questionnaireResponseId,
            effective,
          },
      );
    } catch (error) {
      if (!(error instanceof MeasurementRefusal)) throw error;
      refusals.push(`${extraction.measurement}: ${error.message}`);
    }
  }
  return { measurements, refusals };
};

const extractQuantity = (
  response: QuestionnaireResponse,
  extraction: QuantityExtraction,
): Pick<ExtractedQuantityMeasurement, "kind" | "measurement" | "value"> => {
  const measurement = measurementCatalog[extraction.measurement];
  const answer = singleAnswer(response, extraction.linkId);
  return {
    kind: "quantity",
    measurement,
    value: measuredQuantity(answer, measurement.quantity, extraction.linkId),
  };
};

const extractComponents = (
  response: QuestionnaireResponse,
  extraction: ComponentsExtraction,
): Pick<
  ExtractedComponentsMeasurement,
  "kind" | "measurement" | "components"
> => {
  const measurement = measurementCatalog[extraction.measurement];
  const components: Partial<Record<string, MeasuredQuantity>> = {};
  for (const [componentId, component] of Object.entries(
    measurement.components,
  )) {
    const linkId = extraction.linkIds[componentId];
    if (linkId === undefined) {
      throw new MeasurementRefusal(
        `no linkId declared for component '${componentId}'`,
      );
    }
    components[componentId] = measuredQuantity(
      singleAnswer(response, linkId),
      component.quantity,
      linkId,
    );
  }
  return { kind: "components", measurement, components };
};

const leafItems = (
  items: QuestionnaireResponseItem[] | undefined,
  linkId: string,
): QuestionnaireResponseItem[] =>
  (items ?? []).flatMap((item) => {
    const children = [
      ...(item.item ?? []),
      ...(item.answer ?? []).flatMap((answer) => answer.item ?? []),
    ];
    if (children.length === 0) return item.linkId === linkId ? [item] : [];
    return leafItems(children, linkId);
  });

const singleAnswer = (
  response: QuestionnaireResponse,
  linkId: string,
): QuestionnaireResponseItemAnswer => {
  const items = leafItems(response.item, linkId);
  if (items.length !== 1) {
    throw new MeasurementRefusal(
      `expected exactly one item '${linkId}', found ${items.length}`,
    );
  }
  const answers = items[0].answer ?? [];
  if (answers.length !== 1) {
    throw new MeasurementRefusal(
      `expected exactly one answer for '${linkId}', found ${answers.length}`,
    );
  }
  return answers[0];
};

const measuredQuantity = (
  answer: QuestionnaireResponseItemAnswer,
  declared: UcumQuantity,
  linkId: string,
): MeasuredQuantity => {
  const quantity = answer.valueQuantity;
  if (quantity !== undefined) {
    if (typeof quantity.value !== "number") {
      throw new MeasurementRefusal(`'${linkId}' has no numeric value`);
    }
    const matchesDeclaredUnit =
      quantity.code !== undefined ?
        (quantity.system === undefined || quantity.system === ucumSystem) &&
        quantity.code === declared.code
      : quantity.unit !== undefined ?
        quantity.unit === declared.code || quantity.unit === declared.unit
      : true;
    if (!matchesDeclaredUnit) {
      throw new MeasurementRefusal(
        `'${linkId}' unit '${quantity.code ?? quantity.unit ?? ""}' does not match '${declared.code}'`,
      );
    }
    return { value: quantity.value, quantity: declared };
  }
  const value = answer.valueDecimal ?? answer.valueInteger;
  if (value === undefined) {
    throw new MeasurementRefusal(
      `'${linkId}' has no quantity, decimal, or integer answer`,
    );
  }
  return { value, quantity: declared };
};

const parseEffective = (authored: unknown): DateTime | undefined => {
  if (typeof authored === "string") {
    const dateTime = DateTime.fromISO(authored, { setZone: true });
    return dateTime.isValid ? dateTime : undefined;
  }
  if (authored instanceof Date) {
    return DateTime.fromJSDate(authored, { zone: "utc" });
  }
  if (
    typeof authored === "object" &&
    authored !== null &&
    "toDate" in authored &&
    typeof authored.toDate === "function"
  ) {
    const date: unknown = (authored.toDate as () => unknown)();
    return date instanceof Date ?
        DateTime.fromJSDate(date, { zone: "utc" })
      : undefined;
  }
  return undefined;
};
