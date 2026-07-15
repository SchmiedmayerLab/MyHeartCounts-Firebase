// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import type { Response } from "express";
import { https } from "firebase-functions/v2";
import {
  type CallableFunction,
  type CallableOptions,
  type CallableRequest,
  onCall,
  onRequest,
  type Request,
} from "firebase-functions/v2/https";
import { z } from "zod";

export const privilegedServiceAccount = `cloudfunctionsserviceaccount@${process.env.GCLOUD_PROJECT}.iam.gserviceaccount.com`;
export const defaultServiceAccount = `limited-cloudfunction-sa@${process.env.GCLOUD_PROJECT}.iam.gserviceaccount.com`;

export const validatedOnCall = <Schema extends z.ZodTypeAny, Return>(
  name: string,
  schema: Schema,
  handler: (request: CallableRequest<z.output<Schema>>) => Promise<Return>,
  options: CallableOptions = {
    invoker: "public",
  },
  _helperOptions?: { logRequestData?: boolean },
): CallableFunction<z.input<Schema>, Promise<Return>> => {
  const wrappedHandler = async (request: CallableRequest): Promise<Return> => {
    try {
      const validatedData = schema.parse(request.data) as z.output<Schema>;
      const validatedRequest: CallableRequest<z.output<Schema>> = {
        ...request,
        data: validatedData,
      };
      return await handler(validatedRequest);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new https.HttpsError(
          "invalid-argument",
          "Invalid request data",
          error.errors,
        );
      }
      throw error;
    }
  };
  return onCall(options, wrappedHandler) as CallableFunction<
    z.input<Schema>,
    Promise<Return>
  >;
};

export const validatedOnRequest = <Schema extends z.ZodTypeAny>(
  _name: string,
  schema: Schema,
  handler: (
    request: Request,
    data: z.output<Schema>,
    response: Response,
  ) => void | Promise<void>,
  options: https.HttpsOptions = {
    invoker: "public",
  },
): https.HttpsFunction =>
  onRequest(options, async (request, response) => {
    try {
      const data = schema.parse(request.body) as z.output<Schema>;
      await handler(request, data, response);
      return;
    } catch (error) {
      if (error instanceof z.ZodError) {
        response.status(400).send({
          code: "invalid-argument",
          message: "Invalid request data",
          details: error.errors,
        });
        return;
      }
      throw error;
    }
  });
