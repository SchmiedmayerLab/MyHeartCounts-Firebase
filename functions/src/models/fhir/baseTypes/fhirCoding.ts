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
import { fhirElementConverter } from "./fhirElement.js";

export const fhirCodingConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: fhirElementConverter.value.schema.extend({
        system: optionalish(z.string()),
        version: optionalish(z.string()),
        code: optionalish(z.string()),
        display: optionalish(z.string()),
        userSelected: optionalish(z.boolean()),
      }),
      encode: (object) => {
        const result: Record<string, unknown> = {
          ...fhirElementConverter.value.encode(object),
        };

        if (object.system !== undefined) result.system = object.system;
        if (object.version !== undefined) result.version = object.version;
        if (object.code !== undefined) result.code = object.code;
        if (object.display !== undefined) result.display = object.display;
        if (object.userSelected !== undefined)
          result.userSelected = object.userSelected;

        return result;
      },
    }),
);

export type FHIRCoding = z.output<typeof fhirCodingConverter.value.schema>;
