// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { readFileSync } from "fs";
import { type QuestionnaireResponse } from "fhir/r4b";

export type QuestionnaireResponseFixture =
  | "blood-lipids-1"
  | "blood-lipids-2"
  | "blood-pressure"
  | "blood-glucose-fasting"
  | "bmi-direct"
  | "bmi-compute";

export const questionnaireResponseFixture = (
  name: QuestionnaireResponseFixture,
): QuestionnaireResponse =>
  JSON.parse(
    readFileSync(
      `src/tests/resources/questionnaireResponses/${name}.json`,
      "utf8",
    ),
  ) as QuestionnaireResponse;
