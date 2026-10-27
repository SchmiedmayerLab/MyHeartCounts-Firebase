// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { SchemaConverter } from "./schemaConverter.js";

export const dateConverter = new SchemaConverter({
  schema: z.union([
    z.string().transform((string, context) => {
      try {
        const date = new Date(string);
        if (isNaN(date.getTime())) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Invalid date",
          });
          return z.NEVER;
        }
        return date;
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: String(error),
        });
        return z.NEVER;
      }
    }),
    z.any().transform((value: unknown, context) => {
      // Handle Firestore Timestamps or timestamp-like objects
      if (
        value &&
        typeof value === "object" &&
        "toDate" in value &&
        typeof value.toDate === "function"
      ) {
        try {
          const date = (value as { toDate: () => Date }).toDate();
          if (date instanceof Date && !isNaN(date.getTime())) {
            return date;
          }
        } catch {
          // Fall through to try other approaches
        }
      }

      // Handle Date objects directly
      if (value instanceof Date) {
        if (!isNaN(value.getTime())) {
          return value;
        }
      }

      // Handle null/undefined
      if (value === null || value === undefined) {
        return new Date();
      }

      // try to convert to string then date
      try {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const date = new Date(String(value));
        if (!isNaN(date.getTime())) {
          return date;
        }
      } catch {
        // Continue to error
      }

      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cannot convert value to date: ${typeof value}`,
      });
      return z.NEVER;
    }),
  ]),
  encode: (object) => {
    if (!(object instanceof Date)) {
      return Timestamp.now(); // Default to current timestamp if null
    }
    return Timestamp.fromDate(object);
  },
});

export const dateConverterISO = new SchemaConverter({
  schema: z.union([
    z.string().transform((string, context) => {
      try {
        const date = new Date(string);
        if (isNaN(date.getTime())) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Invalid date",
          });
          return z.NEVER;
        }
        return date;
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: String(error),
        });
        return z.NEVER;
      }
    }),
    z
      .object({
        toDate: z.function().returns(z.date()),
      })
      .transform((timestamp) => timestamp.toDate()),
    z.null().transform(() => new Date()),
  ]),
  encode: (object) => {
    if (!(object instanceof Date)) {
      return new Date().toISOString(); // Default to current date if null
    }
    return object.toISOString();
  },
});
