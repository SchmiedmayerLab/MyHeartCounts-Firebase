// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable import-x/no-cycle */
// Circular dependency is intentional and handled via Lazy wrappers

import { z } from "zod";
import { dateConverterISO } from "../../helpers/dateConverter.js";
import { optionalish } from "../../helpers/optionalish.js";
import { SchemaConverter } from "../../helpers/schemaConverter.js";
import { fhirCodingConverter } from "./fhirCoding.js";

export const fhirMetaConverter = new SchemaConverter({
  schema: z.object({
    versionId: optionalish(z.string()),
    lastUpdated: optionalish(dateConverterISO.schema),
    profile: optionalish(z.string().array()),
    security: optionalish(
      z.lazy(() => fhirCodingConverter.value.schema).array(),
    ),
    tag: optionalish(z.lazy(() => fhirCodingConverter.value.schema).array()),
  }),
  encode: (object) => {
    const result: Record<string, unknown> = {};

    if (object.versionId !== undefined) result.versionId = object.versionId;
    if (object.lastUpdated)
      result.lastUpdated = dateConverterISO.encode(object.lastUpdated);
    if (object.profile && object.profile.length > 0)
      result.profile = object.profile;
    if (object.security && object.security.length > 0) {
      result.security = object.security.map(fhirCodingConverter.value.encode);
    }
    if (object.tag && object.tag.length > 0) {
      result.tag = object.tag.map(fhirCodingConverter.value.encode);
    }

    return result;
  },
});

export type FHIRMeta = z.output<typeof fhirMetaConverter.schema>;
