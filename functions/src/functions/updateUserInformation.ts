// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  updateUserInformationInputSchema,
  type UpdateUserInformationOutput,
} from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";
import { validatedOnCall, defaultServiceAccount } from "./helpers.js";

export const updateUserInformation = validatedOnCall(
  "updateUserInformation",
  updateUserInformationInputSchema,
  async (request): Promise<UpdateUserInformationOutput> => {
    const factory = getServiceFactory();
    const credential = factory.credential(request.auth);
    const userService = factory.user();

    credential.checkUser(request.data.userId);

    await userService.updateAuth(request.data.userId, request.data.data.auth);
  },
  {
    invoker: "public",
    serviceAccount: defaultServiceAccount,
  },
);
