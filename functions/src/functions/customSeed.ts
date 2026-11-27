// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { customSeedingOptionsSchema } from "../models/index.js";
import { getServiceFactory } from "../services/factory/getServiceFactory.js";
import { validatedOnRequest, privilegedServiceAccount } from "./helpers.js";

export const customSeed = validatedOnRequest(
  "customSeed",
  customSeedingOptionsSchema,
  async (_, data, response) => {
    const factory = getServiceFactory();

    if (process.env.FUNCTIONS_EMULATOR !== "true") {
      throw factory.credential(undefined).permissionDeniedError();
    }

    await factory.debugData().seedCustom(data);
    response.write("Success", "utf8");
    response.end();
  },
  {
    invoker: "public",
    serviceAccount: privilegedServiceAccount,
  },
);
