// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable import-x/no-cycle */
// Circular dependency is intentional and handled via Lazy wrappers

import { z } from "zod";
import { Lazy } from "../../helpers/lazy.js";
import { optionalish } from "../../helpers/optionalish.js";
import { SchemaConverter } from "../../helpers/schemaConverter.js";
import { fhirCodingConverter } from "./fhirCoding.js";

export const fhirCodeableConceptConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z.object({
        coding: optionalish(
          z.lazy(() => fhirCodingConverter.value.schema).array(),
        ),
        text: optionalish(z.string()),
      }),
      encode: (object) => {
        const result: Record<string, unknown> = {};

        if (object.coding && object.coding.length > 0) {
          result.coding = object.coding.map(fhirCodingConverter.value.encode);
        }
        if (object.text !== undefined) {
          result.text = object.text;
        }

        return result;
      },
    }),
);

export type FHIRCodeableConcept = z.output<
  typeof fhirCodeableConceptConverter.value.schema
>;
