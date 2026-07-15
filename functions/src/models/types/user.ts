// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  userRegistrationConverter,
  userRegistrationInputConverter,
  UserRegistration,
} from "./userRegistration.js";
import { dateConverter } from "../helpers/dateConverter.js";
import { Lazy } from "../helpers/lazy.js";
import { optionalishDefault, optionalish } from "../helpers/optionalish.js";
import { SchemaConverter } from "../helpers/schemaConverter.js";

export const userConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: userRegistrationInputConverter.value.schema
        .extend({
          dateOfEnrollment: dateConverter.schema,
          lastActiveDate: dateConverter.schema,
          extendedActivityNudgesOptIn: optionalishDefault(z.boolean(), true),
          lastUploadDate: optionalish(dateConverter.schema),
        })
        .transform((values) => new User(values)),
      encode: (object) => ({
        ...userRegistrationConverter.value.encode(object),
        lastActiveDate: dateConverter.encode(object.lastActiveDate),
        lastUploadDate:
          object.lastUploadDate ?
            dateConverter.encode(object.lastUploadDate)
          : null,
        dateOfEnrollment: dateConverter.encode(object.dateOfEnrollment),
        extendedActivityNudgesOptIn: object.extendedActivityNudgesOptIn,
      }),
    }),
);

export class User extends UserRegistration {
  // Properties

  readonly dateOfEnrollment: Date;
  readonly lastActiveDate: Date;
  readonly extendedActivityNudgesOptIn: boolean;
  readonly lastUploadDate?: Date;

  // Constructor

  constructor(input: {
    disabled: boolean;
    dateOfBirth?: Date;
    language?: string;
    timeZone?: string;
    participantGroup?: number;
    dateOfEnrollment: Date;
    lastActiveDate: Date;
    extendedActivityNudgesOptIn: boolean;
    lastUploadDate?: Date;
  }) {
    super(input);
    this.dateOfEnrollment = input.dateOfEnrollment;
    this.lastActiveDate = input.lastActiveDate;
    this.extendedActivityNudgesOptIn = input.extendedActivityNudgesOptIn;
    this.lastUploadDate = input.lastUploadDate;
  }
}
