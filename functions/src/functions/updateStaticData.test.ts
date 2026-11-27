// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { it } from "mocha";
import { CachingStrategy, StaticDataComponent } from "../models/index.js";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";
import { _updateStaticData } from "./updateStaticData.js";

describeWithEmulators("function: updateStaticData", (env) => {
  it("updates static data successfully", async () => {
    await _updateStaticData(env.factory, {
      only: Object.values(StaticDataComponent),
      cachingStrategy: CachingStrategy.expectCache,
    });

    // Questionnaires are no longer used
    const questionnaires = await env.collections.questionnaires.get();
    expect(questionnaires.docs).to.have.length(0);
  });
});
