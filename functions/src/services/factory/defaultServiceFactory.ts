// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { type AuthData } from "firebase-functions/v2/tasks";
import { type ServiceFactory } from "./serviceFactory.js";
import { Lazy } from "../../models/index.js";
import { Credential } from "../credential/credential.js";
import { FirestoreService } from "../database/firestoreService.js";
import { HealthProviderService } from "../healthProviders/healthProviderService.js";
import { DatabaseHistoryService } from "../history/databaseHistoryService.js";
import { type HistoryService } from "../history/historyService.js";
import {
  DietScoreCalculator,
  DietScoringQuestionnaireResponseService,
} from "../questionnaireResponse/dietScoringService.js";
import { HeartRiskLdlParsingQuestionnaireResponseService } from "../questionnaireResponse/heartRiskLdlParsingService.js";
import { HeartRiskNicotineScoringQuestionnaireResponseService } from "../questionnaireResponse/heartRiskNicotineScoringService.js";
import { MultiQuestionnaireResponseService } from "../questionnaireResponse/multiQuestionnaireResponseService.js";
import {
  DefaultNicotineScoreCalculator,
  NicotineScoringQuestionnaireResponseService,
} from "../questionnaireResponse/nicotineScoringService.js";
import { type QuestionnaireResponseService } from "../questionnaireResponse/questionnaireResponseService.js";
import {
  DefaultWho5ScoreCalculator,
  Who5ScoringQuestionnaireResponseService,
} from "../questionnaireResponse/who5ScoringService.js";
import { DebugDataService } from "../seeding/debugData/debugDataService.js";
import { StaticDataService } from "../seeding/staticData/staticDataService.js";
// eslint-disable-next-line import/no-cycle -- TriggerServiceImpl requires ServiceFactory for dependency injection, creating a necessary cycle between factory and service implementation
import {
  TriggerServiceImpl,
  type TriggerService,
} from "../trigger/triggerService.js";
import { DatabaseUserService } from "../user/databaseUserService.js";
import { type UserService } from "../user/userService.js";

export class DefaultServiceFactory implements ServiceFactory {
  // Properties - Options

  // Properties - Firebase

  private readonly auth = new Lazy(() => admin.auth());
  private readonly firestore = new Lazy(() => admin.firestore());
  private readonly storage = new Lazy(() => admin.storage());

  // Properties - Database Layer

  private readonly databaseService = new Lazy(
    () => new FirestoreService(this.firestore.value),
  );

  // Properties - Services

  private readonly debugDataService = new Lazy(
    () =>
      new DebugDataService(
        this.auth.value,
        this.databaseService.value,
        this.storage.value,
      ),
  );

  private readonly historyService = new Lazy(
    () => new DatabaseHistoryService(this.databaseService.value),
  );

  private readonly questionnaireResponseService = new Lazy(
    () =>
      new MultiQuestionnaireResponseService([
        new DietScoringQuestionnaireResponseService({
          databaseService: this.databaseService.value,
          scoreCalculator: new DietScoreCalculator(),
        }),
        new Who5ScoringQuestionnaireResponseService({
          databaseService: this.databaseService.value,
          scoreCalculator: new DefaultWho5ScoreCalculator(),
        }),
        new NicotineScoringQuestionnaireResponseService({
          databaseService: this.databaseService.value,
          scoreCalculator: new DefaultNicotineScoreCalculator(),
        }),
        new HeartRiskNicotineScoringQuestionnaireResponseService({
          databaseService: this.databaseService.value,
        }),
        new HeartRiskLdlParsingQuestionnaireResponseService({
          databaseService: this.databaseService.value,
        }),
      ]),
  );

  private readonly staticDataService = new Lazy(
    () => new StaticDataService(this.databaseService.value),
  );

  private readonly healthProviderService = new Lazy(
    () => new HealthProviderService(this.databaseService.value),
  );

  private readonly triggerService = new Lazy(
    () => new TriggerServiceImpl(this),
  );

  private readonly userService = new Lazy(
    () => new DatabaseUserService(this.auth.value, this.databaseService.value),
  );

  // Methods - User

  credential(authData: AuthData | undefined): Credential {
    return new Credential(authData);
  }

  user(): UserService {
    return this.userService.value;
  }

  // Methods - Data

  debugData(): DebugDataService {
    return this.debugDataService.value;
  }

  staticData(): StaticDataService {
    return this.staticDataService.value;
  }

  history(): HistoryService {
    return this.historyService.value;
  }

  // Methods - Questionnaires

  questionnaireResponse(): QuestionnaireResponseService {
    return this.questionnaireResponseService.value;
  }

  // Methods - Health providers

  healthProvider(): HealthProviderService {
    return this.healthProviderService.value;
  }

  // Methods - Trigger

  trigger(): TriggerService {
    return this.triggerService.value;
  }
}
