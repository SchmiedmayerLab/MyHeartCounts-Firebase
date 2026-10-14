// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { type AuthData } from "firebase-functions/v2/tasks";
import { type Credential } from "../credential/credential.js";
import { type HealthStatsService } from "../healthStats/healthStatsService.js";
import { type HistoryService } from "../history/historyService.js";
import { type QuestionnaireResponseService } from "../questionnaireResponse/questionnaireResponseService.js";
import { type DebugDataService } from "../seeding/debugData/debugDataService.js";
import { type StaticDataService } from "../seeding/staticData/staticDataService.js";
import { type TriggerService } from "../trigger/triggerService.js";
import { type UserService } from "../user/userService.js";

export interface ServiceFactory {
  // Users

  credential(authData: AuthData | undefined): Credential;
  user(): UserService;

  // Data

  debugData(): DebugDataService;
  staticData(): StaticDataService;
  history(): HistoryService;

  // Questionnaires

  questionnaireResponse(): QuestionnaireResponseService;

  // Health Stats

  healthStats(): HealthStatsService;

  // Trigger

  trigger(): TriggerService;
}
