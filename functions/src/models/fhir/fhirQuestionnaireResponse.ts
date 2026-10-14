// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type QuestionnaireResponse } from "fhir/r4b";
import { z } from "zod";
import { fhirCodingConverter } from "./baseTypes/fhirCoding.js";
import {
  FHIRResource,
  fhirResourceConverter,
  type FHIRResourceInput,
} from "./baseTypes/fhirElement.js";
import { dateConverter } from "../helpers/dateConverter.js";
import { Lazy } from "../helpers/lazy.js";
import { optionalish } from "../helpers/optionalish.js";
import { SchemaConverter } from "../helpers/schemaConverter.js";

const fhirQuestionnaireResponseItemBaseConverter = new SchemaConverter({
  schema: z.object({
    answer: optionalish(
      z
        .object({
          valueCoding: optionalish(
            z.lazy(() => fhirCodingConverter.value.schema),
          ),
          valueDate: optionalish(dateConverter.schema),
          valueString: optionalish(z.string()),
          valueBoolean: optionalish(z.boolean()),
          valueInteger: optionalish(z.number()),
          valueDecimal: optionalish(z.number()),
          valueQuantity: optionalish(
            z.object({
              value: optionalish(z.number()),
              unit: optionalish(z.string()),
            }),
          ),
        })
        .array(),
    ),
    linkId: optionalish(z.string()),
  }),
  encode: (object) => ({
    answer:
      object.answer?.flatMap((value) => ({
        valueCoding:
          value.valueCoding ?
            fhirCodingConverter.value.encode(value.valueCoding)
          : null,
        valueDate:
          value.valueDate ? dateConverter.encode(value.valueDate) : null,
        valueString: value.valueString ?? null,
        valueBoolean: value.valueBoolean ?? null,
        valueInteger: value.valueInteger ?? null,
        valueDecimal: value.valueDecimal ?? null,
        valueQuantity: value.valueQuantity ?? null,
      })) ?? null,
    linkId: object.linkId ?? null,
  }),
});

export interface FHIRQuestionnaireResponseItemValue extends z.input<
  typeof fhirQuestionnaireResponseItemBaseConverter.value.schema
> {
  item?:
    | Array<z.input<typeof fhirQuestionnaireResponseItemConverter.value.schema>>
    | null
    | undefined;
}

export const fhirQuestionnaireResponseItemConverter = (() => {
  const fhirQuestionnaireResponseItemSchema: z.ZodType<
    FHIRQuestionnaireResponseItem,
    z.ZodTypeDef,
    FHIRQuestionnaireResponseItemValue
  > = fhirQuestionnaireResponseItemBaseConverter.value.schema.extend({
    item: optionalish(
      z.array(z.lazy(() => fhirQuestionnaireResponseItemSchema)),
    ),
  });

  const fhirQuestionnaireResponseItemEncode = (
    object: z.output<typeof fhirQuestionnaireResponseItemSchema>,
  ): z.input<typeof fhirQuestionnaireResponseItemSchema> => ({
    ...fhirQuestionnaireResponseItemBaseConverter.value.encode(object),
    item:
      object.item ?
        object.item.map(fhirQuestionnaireResponseItemConverter.value.encode)
      : null,
  });

  return new SchemaConverter({
    schema: fhirQuestionnaireResponseItemSchema,
    encode: fhirQuestionnaireResponseItemEncode,
  });
})();

export interface FHIRQuestionnaireResponseItem extends z.output<
  typeof fhirQuestionnaireResponseItemBaseConverter.value.schema
> {
  item?: FHIRQuestionnaireResponseItem[];
}

export const fhirQuestionnaireResponseConverter = new Lazy(() => {
  const schema = fhirResourceConverter.value.schema.extend({
    authored: dateConverter.schema,
    item: optionalish(
      z.lazy(() => fhirQuestionnaireResponseItemConverter.value.schema).array(),
    ),
    questionnaire: z.string(),
  });
  return new SchemaConverter({
    schema: z.unknown().transform((raw, context) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        for (const issue of result.error.issues) context.addIssue(issue);
        return z.NEVER;
      }
      return new FHIRQuestionnaireResponse({
        ...result.data,
        value: raw as QuestionnaireResponse,
      });
    }),
    encode: (object) => ({
      ...fhirResourceConverter.value.encode(object),
      authored: dateConverter.encode(object.authored),
      item:
        object.item?.map(fhirQuestionnaireResponseItemConverter.value.encode) ??
        null,
      questionnaire: object.questionnaire,
    }),
  });
});

export class FHIRQuestionnaireResponse extends FHIRResource {
  // Stored Properties

  readonly resourceType: string = "QuestionnaireResponse";
  readonly authored: Date;
  readonly item?: FHIRQuestionnaireResponseItem[];
  readonly questionnaire: string;
  // Source FHIR JSON as written by the client; absent when constructed in code.
  readonly value?: QuestionnaireResponse;

  // Constructor

  constructor(
    input: FHIRResourceInput & {
      authored: Date;
      item?: FHIRQuestionnaireResponseItem[];
      questionnaire: string;
      value?: QuestionnaireResponse;
    },
  ) {
    super(input);
    this.authored = input.authored;
    this.item = input.item;
    this.questionnaire = input.questionnaire;
    this.value = input.value;
  }

  // Methods

  responseItem(linkIdPath: string[]): FHIRQuestionnaireResponseItem | null {
    const items = this.responseItems(linkIdPath);
    switch (items.length) {
      case 0:
        return null;
      case 1:
        return items[0];
      default:
        throw new Error("Unexpected number of response items found.");
    }
  }

  responseItems(linkIdPath: string[]): FHIRQuestionnaireResponseItem[] {
    const resultValue: FHIRQuestionnaireResponseItem[] = [];
    for (const child of this.item ?? []) {
      resultValue.push(...this.responseItemsRecursive(linkIdPath, child));
    }
    return resultValue;
  }

  leafResponseItem(linkId: string): FHIRQuestionnaireResponseItem | null {
    const items = this.leafResponseItems(linkId);
    switch (items.length) {
      case 0:
        return null;
      case 1:
        return items[0];
      default:
        throw new Error("Unexpected number of leaf response items found.");
    }
  }

  leafResponseItems(linkId: string): FHIRQuestionnaireResponseItem[] {
    const items: FHIRQuestionnaireResponseItem[] = [];
    for (const item of this.item ?? []) {
      items.push(...this.leafResponseItemsRecursive(linkId, item));
    }
    return items;
  }

  numericSingleAnswerForLink(linkId: string): number {
    for (const item of this.item ?? []) {
      const answer = this.numericSingleAnswerForNestedItem(linkId, item);
      if (answer !== undefined) return answer;
    }
    throw new Error(`No answer found in response for linkId ${linkId}.`);
  }

  private responseItemsRecursive(
    linkIdPath: string[],
    item: FHIRQuestionnaireResponseItem,
  ): FHIRQuestionnaireResponseItem[] {
    switch (linkIdPath.length) {
      case 0:
        break;
      case 1:
        if (item.linkId === linkIdPath[0]) {
          return [item];
        }
        break;
      default:
        if (item.linkId === linkIdPath[0]) {
          const childLinkIds = linkIdPath.slice(1);
          const resultValue: FHIRQuestionnaireResponseItem[] = [];
          for (const child of item.item ?? []) {
            resultValue.push(
              ...this.responseItemsRecursive(childLinkIds, child),
            );
          }
          return resultValue;
        }
        break;
    }
    return [];
  }

  private leafResponseItemsRecursive(
    linkId: string,
    item: FHIRQuestionnaireResponseItem,
  ): FHIRQuestionnaireResponseItem[] {
    const children = item.item ?? [];
    if (children.length === 0 && item.linkId === linkId) {
      return [item];
    }
    const items: FHIRQuestionnaireResponseItem[] = [];
    for (const child of item.item ?? []) {
      items.push(...this.leafResponseItemsRecursive(linkId, child));
    }
    return items;
  }

  private numericSingleAnswerForNestedItem(
    linkId: string,
    item: FHIRQuestionnaireResponseItem,
  ): number | undefined {
    if (item.linkId === linkId) {
      return this.numericSingleAnswerForItem(linkId, item);
    }
    for (const child of item.item ?? []) {
      const childAnswer = this.numericSingleAnswerForNestedItem(linkId, child);
      if (childAnswer !== undefined) return childAnswer;
    }
    return undefined;
  }

  private numericSingleAnswerForItem(
    linkId: string,
    item: FHIRQuestionnaireResponseItem,
  ): number {
    const answers = item.answer ?? [];
    if (answers.length !== 1)
      throw new Error(
        `Zero or multiple answers found in response item for linkId ${linkId}.`,
      );
    const code = answers[0].valueCoding?.code;
    if (!code)
      throw new Error(
        `No answer code found in response item for linkId ${linkId}.`,
      );
    return parseInt(code);
  }
}
