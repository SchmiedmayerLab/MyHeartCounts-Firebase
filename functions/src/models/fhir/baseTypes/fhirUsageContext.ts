// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { optionalish } from "../../helpers/optionalish.js";
import { SchemaConverter } from "../../helpers/schemaConverter.js";
import { fhirCodeableConceptConverter } from "./fhirCodeableConcept.js";
import { fhirCodingConverter } from "./fhirCoding.js";
import { fhirQuantityConverter } from "./fhirQuantity.js";

export const fhirUsageContextConverter = new SchemaConverter({
  schema: z.object({
    code: fhirCodingConverter.value.schema,
    valueCodeableConcept: optionalish(
      z.lazy(() => fhirCodeableConceptConverter.value.schema),
    ),
    valueQuantity: optionalish(
      z.lazy(() => fhirQuantityConverter.value.schema),
    ),
  }),
  encode: (object) => ({
    code: fhirCodingConverter.value.encode(object.code),
    valueCodeableConcept:
      object.valueCodeableConcept ?
        fhirCodeableConceptConverter.value.encode(object.valueCodeableConcept)
      : null,
    valueQuantity:
      object.valueQuantity ?
        fhirQuantityConverter.value.encode(object.valueQuantity)
      : null,
  }),
});

export type FHIRUsageContext = z.output<
  typeof fhirUsageContextConverter.schema
>;
