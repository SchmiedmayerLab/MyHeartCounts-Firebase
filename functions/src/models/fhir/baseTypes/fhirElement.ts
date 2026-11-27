// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable import-x/no-cycle */
// Circular dependency is intentional and handled via Lazy wrappers

import { z } from "zod";
import { optionalish } from "../../helpers/optionalish.js";
import { SchemaConverter } from "../../helpers/schemaConverter.js";
import {
  fhirCodeableConceptConverter,
  type FHIRCodeableConcept,
} from "./fhirCodeableConcept.js";
import { type FHIRCoding } from "./fhirCoding.js";
import { type FHIRMeta, fhirMetaConverter } from "./fhirMeta.js";
import { fhirQuantityConverter } from "./fhirQuantity.js";
import { fhirReferenceConverter } from "./fhirReference.js";

const fhirExtensionBaseConverter = new SchemaConverter({
  schema: z.object({
    url: z.string(),
    valueQuantities: optionalish(
      z.lazy(() => fhirQuantityConverter.value.schema).array(),
    ),
    valueReference: optionalish(
      z.lazy(() => fhirReferenceConverter.value.schema),
    ),
    valueString: optionalish(z.string()),
  }),
  encode: (object) => {
    const result: Record<string, unknown> = {
      url: object.url,
    };

    if (object.valueQuantities && object.valueQuantities.length > 0) {
      result.valueQuantities = object.valueQuantities.map(
        fhirQuantityConverter.value.encode,
      );
    }
    if (object.valueReference) {
      result.valueReference = fhirReferenceConverter.value.encode(
        object.valueReference,
      );
    }
    if (object.valueString !== undefined) {
      result.valueString = object.valueString;
    }

    return result;
  },
});

export interface FHIRExtensionInput extends z.input<
  typeof fhirExtensionBaseConverter.value.schema
> {
  valueCodeableConcept?:
    | z.input<typeof fhirCodeableConceptConverter.value.schema>
    | null
    | undefined;
}

export interface FHIRExtension extends z.output<
  typeof fhirExtensionBaseConverter.value.schema
> {
  valueCodeableConcept?: FHIRCodeableConcept;
}

export const fhirExtensionConverter = (() => {
  const fhirExtensionSchema: z.ZodType<
    FHIRExtension,
    z.ZodTypeDef,
    FHIRExtensionInput
  > = fhirExtensionBaseConverter.value.schema.extend({
    valueCodeableConcept: optionalish(
      z.lazy(() => fhirCodeableConceptConverter.value.schema),
    ),
  });

  const fhirExtensionEncode = (
    object: z.output<typeof fhirExtensionSchema>,
  ): z.input<typeof fhirExtensionSchema> => {
    const result: Record<string, unknown> = {
      ...fhirExtensionBaseConverter.value.encode(object),
    };

    if (object.valueCodeableConcept) {
      result.valueCodeableConcept = fhirCodeableConceptConverter.value.encode(
        object.valueCodeableConcept,
      );
    }

    return result as unknown as z.input<typeof fhirExtensionSchema>;
  };

  return new SchemaConverter({
    schema: fhirExtensionSchema,
    encode: fhirExtensionEncode,
  });
})();

export const fhirElementConverter = new SchemaConverter({
  schema: z.object({
    id: optionalish(z.string()),
    extension: optionalish(
      z.lazy(() => fhirExtensionConverter.value.schema).array(),
    ),
  }),
  encode: (object) => {
    const result: Record<string, unknown> = {};

    if (object.id !== undefined) {
      result.id = object.id;
    }
    if (object.extension && object.extension.length > 0) {
      result.extension = object.extension.map(
        fhirExtensionConverter.value.encode,
      );
    }

    return result;
  },
});

export abstract class FHIRElement {
  // Properties

  readonly id?: string;
  readonly extension?: FHIRExtension[];

  // Constructor

  constructor(input: { id?: string; extension?: FHIRExtension[] }) {
    this.id = input.id;
    this.extension = input.extension;
  }
}

export const fhirResourceConverter = new SchemaConverter({
  schema: fhirElementConverter.value.schema.extend({
    resourceType: z.string(),
    meta: optionalish(fhirMetaConverter.schema),
  }),
  encode: (object) => {
    const result: Record<string, unknown> = {
      ...fhirElementConverter.value.encode(object),
      resourceType: object.resourceType,
    };

    if (object.meta) {
      result.meta = fhirMetaConverter.encode(object.meta);
    }

    return result;
  },
});

export type FHIRResourceInput = z.output<typeof fhirElementConverter.schema> & {
  meta?: FHIRMeta;
};

export abstract class FHIRResource extends FHIRElement {
  // Properties

  abstract get resourceType(): string;
  readonly meta?: FHIRMeta;

  // Constructor

  constructor(input: FHIRResourceInput) {
    super(input);
    this.meta = input.meta;
  }

  // Methods

  codes(
    concept: FHIRCodeableConcept | undefined,
    filter: FHIRCoding,
  ): string[] {
    return (
      concept?.coding?.flatMap((coding) => {
        if (filter.system && coding.system !== filter.system) return [];
        if (filter.version && coding.version !== filter.version) return [];
        return coding.code ? [coding.code] : [];
      }) ?? []
    );
  }

  containsCoding(
    concept: FHIRCodeableConcept | undefined,
    filter: FHIRCoding[],
  ): boolean {
    return filter.some(
      (filterCoding) =>
        concept?.coding?.some((coding) => {
          if (filterCoding.code && coding.code !== filterCoding.code)
            return false;
          if (filterCoding.system && coding.system !== filterCoding.system)
            return false;
          if (filterCoding.version && coding.version !== filterCoding.version)
            return false;
          return true;
        }) ?? false,
    );
  }
}
