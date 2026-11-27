// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { type QuestionnaireReference } from "../codes/references.js";
import { advanceDateByDays } from "../helpers/date+extras.js";
import { dateConverter } from "../helpers/dateConverter.js";
import { Lazy } from "../helpers/lazy.js";
import { optionalish } from "../helpers/optionalish.js";
import { SchemaConverter } from "../helpers/schemaConverter.js";
import { LocalizedText, localizedTextConverter } from "./localizedText.js";

export enum UserMessageType {
  weightGain = "WeightGain",
  welcome = "Welcome",
  vitals = "Vitals",
  questionnaire = "Questionnaire",
  symptomQuestionnaire = "SymptomQuestionnaire",
  preAppointment = "PreAppointment",
  inactive = "Inactive",
}

export const userMessageConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: z
        .object({
          creationDate: dateConverter.schema,
          dueDate: optionalish(dateConverter.schema),
          completionDate: optionalish(dateConverter.schema),
          type: z.nativeEnum(UserMessageType),
          title: z.lazy(() => localizedTextConverter.schema),
          description: optionalish(z.lazy(() => localizedTextConverter.schema)),
          action: optionalish(z.string()),
          isDismissible: z.boolean(),
          reference: optionalish(z.string()),
        })
        .transform((content) => new UserMessage(content)),
      encode: (object) => ({
        creationDate: dateConverter.encode(object.creationDate),
        dueDate: object.dueDate ? dateConverter.encode(object.dueDate) : null,
        completionDate:
          object.completionDate ?
            dateConverter.encode(object.completionDate)
          : null,
        type: object.type,
        title: localizedTextConverter.encode(object.title),
        description:
          object.description ?
            localizedTextConverter.encode(object.description)
          : null,
        action: object.action ?? null,
        isDismissible: object.isDismissible,
        reference: object.reference ?? null,
      }),
    }),
);

export class UserMessage {
  // Static Functions

  static createInactive(
    input: {
      creationDate?: Date;
    } = {},
  ): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: "Inactive",
      }),
      description: LocalizedText.raw({
        en: "You have been inactive for 7 days. Please log in to continue your care.",
      }),
      action: undefined,
      type: UserMessageType.inactive,
      isDismissible: false,
    });
  }

  static createInactiveForClinician(input: {
    creationDate?: Date;
    userId: string;
    userName?: string;
    reference: string;
  }): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: "Inactive",
      }),
      description: LocalizedText.raw({
        en: `${input.userName ?? "Patient"} has been inactive for 7 days.`,
      }),
      action: `users/${input.userId}`,
      type: UserMessageType.inactive,
      isDismissible: true,
      reference: input.reference,
    });
  }

  static createPreAppointment(input: {
    creationDate?: Date;
    reference: string;
  }): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: "Appointment Reminder",
      }),
      description: LocalizedText.raw({
        en: "Your appointment is coming up. Review your Health Summary before your visit.",
      }),
      action: "healthSummary",
      type: UserMessageType.preAppointment,
      isDismissible: false,
      reference: input.reference,
    });
  }

  static createPreAppointmentForClinician(input: {
    creationDate?: Date;
    userId: string;
    userName?: string;
    reference: string;
  }): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: "Appointment Reminder",
      }),
      description: LocalizedText.raw({
        en: `Appointment with ${input.userName ?? "patient"} is coming up.`,
      }),
      action: `users/${input.userId}/appointments`,
      reference: input.reference,
      type: UserMessageType.preAppointment,
      isDismissible: true,
    });
  }

  static createQuestionnaire(input: {
    creationDate?: Date;
    questionnaireReference: QuestionnaireReference;
    title?: string;
    description?: string;
  }): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: input.title ?? "Questionnaire",
      }),
      description: LocalizedText.raw({
        en: input.description ?? "Please complete this questionnaire.",
      }),
      action: input.questionnaireReference,
      type: UserMessageType.questionnaire,
      isDismissible: false,
    });
  }

  static createSymptomQuestionnaire(input: {
    creationDate?: Date;
    questionnaireReference: QuestionnaireReference;
  }): UserMessage {
    return UserMessage.createQuestionnaire({
      ...input,
      title: "Symptom Questionnaire",
      description: "Complete your Symptom Survey for your care team.",
    });
  }

  static createVitals(
    input: {
      creationDate?: Date;
    } = {},
  ): UserMessage {
    const creationDate = input.creationDate ?? new Date();
    return new UserMessage({
      creationDate: creationDate,
      dueDate: advanceDateByDays(creationDate, 1),
      title: LocalizedText.raw({
        en: "Vitals",
      }),
      description: LocalizedText.raw({
        en: "Check your blood pressure and weight daily.",
      }),
      action: "observations",
      type: UserMessageType.vitals,
      isDismissible: false,
    });
  }

  static createWeightGain(
    input: {
      creationDate?: Date;
    } = {},
  ): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: "Weight increase since last week",
      }),
      description: LocalizedText.raw({
        en: "Your weight increased over 3 lbs. Your care team will be informed.",
      }),
      action: "observations",
      type: UserMessageType.weightGain,
      isDismissible: true,
    });
  }

  static createWeightGainForClinician(input: {
    creationDate?: Date;
    userId: string;
    userName?: string;
    reference: string;
  }): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: "Weight increase since last week",
      }),
      description: LocalizedText.raw({
        en: `Weight increase over 3 lbs for ${input.userName ?? "patient"}.`,
      }),
      action: `users/${input.userId}/observations`,
      reference: input.reference,
      type: UserMessageType.weightGain,
      isDismissible: true,
    });
  }

  static createWelcome(input: { creationDate?: Date }): UserMessage {
    return new UserMessage({
      creationDate: input.creationDate ?? new Date(),
      title: LocalizedText.raw({
        en: "Welcome",
      }),
      type: UserMessageType.welcome,
      isDismissible: true,
    });
  }

  // Properties

  readonly creationDate: Date;
  readonly dueDate?: Date;
  readonly completionDate?: Date;
  readonly type: UserMessageType;
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly action?: string;
  readonly isDismissible: boolean;
  readonly reference?: string;

  // Constructor

  constructor(input: {
    creationDate: Date;
    dueDate?: Date;
    completionDate?: Date;
    type: UserMessageType;
    title: LocalizedText;
    description?: LocalizedText;
    action?: string;
    isDismissible: boolean;
    reference?: string;
  }) {
    this.creationDate = input.creationDate;
    this.dueDate = input.dueDate;
    this.completionDate = input.completionDate;
    this.type = input.type;
    this.title = input.title;
    this.description = input.description;
    this.action = input.action;
    this.isDismissible = input.isDismissible;
    this.reference = input.reference;
  }
}
