// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { Lazy } from "../helpers/lazy.js";
import { optionalish } from "../helpers/optionalish.js";
import { SchemaConverter } from "../helpers/schemaConverter.js";
import {
  FHIRResource,
  fhirResourceConverter,
  type FHIRResourceInput,
} from "./baseTypes/fhirElement.js";
import {
  fhirQuestionnaireItemConverter,
  type FHIRQuestionnaireItem,
} from "./baseTypes/fhirQuestionnaireItem.js";
import {
  type FHIRUsageContext,
  fhirUsageContextConverter,
} from "./baseTypes/fhirUsageContext.js";

export enum FHIRQuestionnairePublicationStatus {
  draft = "draft",
  active = "active",
  retired = "retired",
  unknown = "unknown",
}

export const fhirContactPointConverter = new SchemaConverter({
  schema: z.object({
    system: optionalish(z.string()),
    value: optionalish(z.string()),
  }),
  encode: (object) => ({
    system: object.system ?? null,
    value: object.value ?? null,
  }),
});

export type FHIRContactPoint = z.output<
  typeof fhirContactPointConverter.schema
>;

export const fhirContactDetailConverter = new SchemaConverter({
  schema: z.object({
    name: optionalish(z.string()),
    telecom: optionalish(
      z.lazy(() => fhirContactPointConverter.value.schema).array(),
    ),
  }),
  encode: (object) => ({
    name: object.name ?? null,
    telecom:
      object.telecom?.map(fhirContactPointConverter.value.encode) ?? null,
  }),
});

export type FHIRContactDetail = z.output<
  typeof fhirContactDetailConverter.schema
>;

export const fhirQuestionnaireConverter = new Lazy(
  () =>
    new SchemaConverter({
      schema: fhirResourceConverter.value.schema
        .extend({
          status: z.nativeEnum(FHIRQuestionnairePublicationStatus),
          title: optionalish(z.string()),
          language: optionalish(z.string()),
          subjectType: optionalish(z.string().array()),
          publisher: optionalish(z.string()),
          useContext: optionalish(fhirUsageContextConverter.schema.array()),
          url: optionalish(z.string()),
          contact: optionalish(
            z.lazy(() => fhirContactDetailConverter.value.schema).array(),
          ),
          item: optionalish(
            z.lazy(() => fhirQuestionnaireItemConverter.value.schema).array(),
          ),
        })
        .transform((values) => new FHIRQuestionnaire(values)),
      encode: (object) => ({
        ...fhirResourceConverter.value.encode(object),
        title: object.title ?? null,
        status: object.status,
        language: object.language ?? null,
        subjectType: object.subjectType ?? null,
        contact:
          object.contact?.map(fhirContactDetailConverter.value.encode) ?? null,
        useContext:
          object.useContext?.map(fhirUsageContextConverter.encode) ?? null,
        publisher: object.publisher ?? null,
        url: object.url ?? null,
        item:
          object.item?.map(fhirQuestionnaireItemConverter.value.encode) ?? null,
      }),
    }),
);

export class FHIRQuestionnaire extends FHIRResource {
  // Properties

  readonly resourceType: string = "Questionnaire";
  readonly title?: string;
  readonly status: FHIRQuestionnairePublicationStatus;
  readonly language?: string;
  readonly contact?: FHIRContactDetail[];
  readonly useContext?: FHIRUsageContext[];
  readonly subjectType?: string[];
  readonly publisher?: string;
  readonly url?: string;
  readonly item?: FHIRQuestionnaireItem[];

  // Constructor

  constructor(
    input: FHIRResourceInput & {
      title?: string;
      status: FHIRQuestionnairePublicationStatus;
      language?: string;
      contact?: FHIRContactDetail[];
      useContext?: FHIRUsageContext[];
      subjectType?: string[];
      publisher?: string;
      url?: string;
      item?: FHIRQuestionnaireItem[];
    },
  ) {
    super(input);
    this.title = input.title;
    this.status = input.status;
    this.language = input.language;
    this.contact = input.contact;
    this.useContext = input.useContext;
    this.subjectType = input.subjectType;
    this.publisher = input.publisher;
    this.url = input.url;
    this.item = input.item;
  }
}
