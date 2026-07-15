// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { logger } from "firebase-functions";
// eslint-disable-next-line import/no-cycle
import { _updateStaticData } from "../../functions/updateStaticData.js";
import {
  type FHIRQuestionnaireResponse,
  type User,
  type CachingStrategy,
  StaticDataComponent,
  type UserRegistration,
} from "../../models/index.js";
import { type Document } from "../database/databaseService.js";
import { type ServiceFactory } from "../factory/serviceFactory.js";

export interface TriggerService {
  // Event triggers
  userEnrolled(user: Document<User>): Promise<void>;
  userCreated(userId: string): Promise<void>;
  userUpdated(userId: string): Promise<void>;
  processQuestionnaireResponse(
    userId: string,
    questionnaireResponse: Document<FHIRQuestionnaireResponse>,
  ): Promise<void>;
  userObservationWritten(
    userId: string,
    observationType: string,
    documentId: string,
    document: Document<unknown>,
  ): Promise<void>;

  questionnaireResponseWritten(
    userId: string,
    questionnaireResponseId: string,
    before?: Document<FHIRQuestionnaireResponse>,
    after?: Document<FHIRQuestionnaireResponse>,
  ): Promise<void>;

  // Testing-only methods - exposed for coverage
  sendDailyReminders(): Promise<void>;
  sendWeeklySymptomQuestionnaires(): Promise<void>;
  updateStaticData(cachingStrategy: CachingStrategy): Promise<void>;
  userRegistrationWritten(
    userId: string,
    document: Document<UserRegistration>,
  ): Promise<void>;
}

export class TriggerServiceImpl implements TriggerService {
  // Properties

  private readonly factory: ServiceFactory;

  // Constructor

  constructor(factory: ServiceFactory) {
    this.factory = factory;
  }

  // Methods - Schedule

  async sendDailyReminders(): Promise<void> {
    // no-op
  }

  async sendWeeklySymptomQuestionnaires(): Promise<void> {
    // no-op
  }

  // Implementation of interface methods

  async userEnrolled(user: Document<User>): Promise<void> {
    await this.userCreated(user.id);
  }

  async userObservationWritten(
    _userId: string,
    _observationType: string,
    _documentId: string,
    _document: Document<unknown>,
  ): Promise<void> {
    // no-op
  }

  // Methods - Events

  async userCreated(_userId: string): Promise<void> {
    // no-op
  }

  async userUpdated(_userId: string): Promise<void> {
    // no-op
  }

  async userRegistrationWritten(
    _userId: string,
    _document: Document<UserRegistration>,
  ): Promise<void> {
    // no-op
  }

  // Methods - Actions

  async updateStaticData(cachingStrategy: CachingStrategy): Promise<void> {
    await _updateStaticData(this.factory, {
      cachingStrategy,
      only: Object.values(StaticDataComponent),
    });
  }

  // Helpers - Implements TriggerService interface

  async processQuestionnaireResponse(
    userId: string,
    document: Document<FHIRQuestionnaireResponse>,
  ): Promise<void> {
    const questionnaireResponseService = this.factory.questionnaireResponse();
    await questionnaireResponseService.handle(
      userId,
      document,
      { isNew: true }, // Default to new, can be refined based on context
    );
  }

  async questionnaireResponseWritten(
    userId: string,
    questionnaireResponseId: string,
    before?: Document<FHIRQuestionnaireResponse>,
    after?: Document<FHIRQuestionnaireResponse>,
  ): Promise<void> {
    try {
      if (after !== undefined) {
        const questionnaireResponseService =
          this.factory.questionnaireResponse();
        await questionnaireResponseService.handle(
          userId,
          {
            id: questionnaireResponseId,
            path: `users/${userId}/questionnaireResponses/${questionnaireResponseId}`,
            lastUpdate: new Date(),
            content: after.content,
          },
          { isNew: before === undefined },
        );
      }
    } catch (error) {
      logger.error(
        `TriggerService.questionnaireResponseWritten(${userId}, ${questionnaireResponseId}): Error handling questionnaire response: ${String(error)}`,
      );
    }
  }

  private async sendSymptomQuestionnaireReminderIfNeeded(
    _userId: string,
  ): Promise<void> {
    // no-op
  }
}
