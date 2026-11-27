// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { Lazy } from "../../helpers/lazy.js";
import { optionalish } from "../../helpers/optionalish.js";
import { SchemaConverter } from "../../helpers/schemaConverter.js";
import { fhirCodingConverter } from "./fhirCoding.js";
import { fhirExtensionConverter } from "./fhirElement.js";

export enum FHIRQuestionnaireItemType {
  group = "group",
  display = "display",
  choice = "choice",
}

const fhirQuestionnaireItemBaseConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z.object({
        linkId: optionalish(z.string()),
        type: optionalish(z.nativeEnum(FHIRQuestionnaireItemType)),
        text: optionalish(z.string()),
        required: optionalish(z.boolean()),
        answerOption: optionalish(
          z
            .object({
              valueCoding: optionalish(
                z.lazy(() => fhirCodingConverter.value.schema),
              ),
            })
            .array(),
        ),
        extension: z.lazy(() =>
          optionalish(fhirExtensionConverter.schema.array()),
        ),
      }),
      encode: (object) => ({
        linkId: object.linkId ?? null,
        type: object.type ?? null,
        text: object.text ?? null,
        required: object.required ?? null,
        answerOption:
          object.answerOption?.map((option) => ({
            valueCoding:
              option.valueCoding ?
                fhirCodingConverter.value.encode(option.valueCoding)
              : null,
          })) ?? null,
        extension:
          object.extension ?
            object.extension.map(fhirExtensionConverter.encode)
          : null,
      }),
    }),
);

export interface FHIRQuestionnaireItemInput extends z.input<
  typeof fhirQuestionnaireItemBaseConverter.value.schema
> {
  item?: FHIRQuestionnaireItemInput[] | null | undefined;
}

export interface FHIRQuestionnaireItem extends z.output<
  typeof fhirQuestionnaireItemBaseConverter.value.schema
> {
  item?: FHIRQuestionnaireItem[];
}

export const fhirQuestionnaireItemConverter = new Lazy(() => {
  const fhirQuestionnaireItemSchema: z.ZodType<
    FHIRQuestionnaireItem,
    z.ZodTypeDef,
    FHIRQuestionnaireItemInput
  > = fhirQuestionnaireItemBaseConverter.value.schema.extend({
    item: optionalish(z.lazy(() => fhirQuestionnaireItemSchema.array())),
  });

  const fhirQuestionnaireItemEncode = (
    object: z.output<typeof fhirQuestionnaireItemSchema>,
  ): z.input<typeof fhirQuestionnaireItemSchema> => ({
    ...fhirQuestionnaireItemBaseConverter.value.encode(object),
    item: object.item ? object.item.map(fhirQuestionnaireItemEncode) : null,
  });

  return new SchemaConverter({
    schema: fhirQuestionnaireItemSchema,
    encode: fhirQuestionnaireItemEncode,
  });
});
