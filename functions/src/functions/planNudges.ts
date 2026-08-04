// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";
import admin from "firebase-admin";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { DateTime } from "luxon";
import OpenAI from "openai";
import { getLlmApiBaseUrl, getLlmApiKey, llmSecretParams } from "../env.js";
import { privilegedServiceAccount } from "./helpers.js";
import {
  getPredefinedNudgeMessages,
  type BaseNudgeMessage,
} from "./nudgeMessages.js";

interface UserData {
  genderIdentity?: string;
  mhcGenderIdentity?: number;
  dateOfBirth?: Date | string | admin.firestore.Timestamp;
  comorbidities?: Record<string, unknown>;
  stageOfChange?: string;
  educationUS?: string;
  educationUK?: string;
  preferredNotificationTime?: string;
  timeZone?: string;
  dateOfEnrollment?: Date | string | admin.firestore.Timestamp;
  participantGroup?: number;
  didOptInToTrial?: boolean;
  triggerNudgeGeneration?: boolean;
  userLanguage?: string;
  disabled?: boolean;
  hasWithdrawnFromStudy?: boolean;
  mostRecentOnboardingStep?: string;
}

enum Disease {
  HEART_FAILURE = "Heart failure",
  PULMONARY_ARTERIAL_HYPERTENSION = "Pulmonary arterial hypertension",
  DIABETES = "Diabetes",
  CORONARY_ARTERY_DISEASE = "Coronary artery disease",
  ACHD_SIMPLE = "ACHD (simple)",
  ACHD_COMPLEX = "ACHD (complex)",
}

enum StageOfChange {
  PRECONTEMPLATION = "Precontemplation",
  CONTEMPLATION = "Contemplation",
  PREPARATION = "Preparation",
  ACTION = "Action",
  MAINTENANCE = "Maintenance",
}

// Education level IDs as defined in the iOS app for both US and UK variants.
// See EducationStatusUS and EducationStatusUK in the iOS codebase.
enum EducationLevel {
  DID_NOT_ATTEND_SCHOOL = "didNotAttendSchool",
  GRADE_SCHOOL = "gradeSchool",
  HIGH_SCHOOL = "highSchool",
  VOCATIONAL_TRAINING = "vocationalTraining",
  SOME_COLLEGE = "someCollege",
  BACHELOR = "bachelor",
  MASTER = "master",
  DOCTORAL_DEGREE = "doctoralDegree",
}

const mhcGenderIdentityMap: Partial<Record<number, string>> = {
  0: "prefer not to state",
  1: "male",
  2: "female",
  3: "trans female",
  4: "trans male",
  5: "other",
};

// Model ID as exposed by the configured LLM API gateway. Must be one of the
// models the gateway API key has access to.
const LLM_MODEL = "gpt-5.2";

const LLM_REQUEST_TIMEOUT_MS = 60_000;

// Version of the LLM prompt template built in generateLLMNudges. Bump this
// whenever the prompt wording changes so generated nudges can be traced back
// to the exact prompt version that produced them.
const PROMPT_VERSION = "1.0.0";

interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface NudgeMessage extends BaseNudgeMessage {
  generatedAt: admin.firestore.Timestamp;
  llmPrompt?: string;
  llmPromptVersion?: string;
  llmTokenUsage?: LlmTokenUsage;
  llmModel?: string;
}

export class NudgeService {
  // Properties

  private static readonly DEFAULT_NOTIFICATION_TIME = "09:00";
  private readonly firestore: admin.firestore.Firestore;

  // Constructor

  constructor(firestore?: admin.firestore.Firestore) {
    this.firestore = firestore ?? admin.firestore();
  }

  // Methods

  private mapComorbidityKeyToDisease(key: string): Disease | null {
    // These are defined for iOS in https://github.com/SchmiedmayerLab/MyHeartCounts-iOS/blob/main/MyHeartCounts/Account/Demographics/Comorbidities.swift.
    switch (key) {
      case "heartFailure":
        return Disease.HEART_FAILURE;
      case "pulmonaryArterialHypertension":
        return Disease.PULMONARY_ARTERIAL_HYPERTENSION;
      case "diabetes":
        return Disease.DIABETES;
      case "coronaryArteryDisease":
        return Disease.CORONARY_ARTERY_DISEASE;
      case "adultCongenitalHeartDisease":
        return Disease.ACHD_COMPLEX;
      case "congenitalHeartDisease2":
        return Disease.ACHD_SIMPLE;
      default:
        logger.warn(`Not mapped for ComorbidityKeyToDisease: ${key}`);
        return null;
    }
  }

  private mapStageOfChangeKey(key: string | undefined): StageOfChange | null {
    if (!key) return null;

    switch (
      key.toLowerCase() //map keys to SoCs. Multiswitch case for maintenance SoC.
    ) {
      case "a":
      case "b":
      case "g":
      case "h":
      case "i":
        return StageOfChange.MAINTENANCE;
      case "c":
        return StageOfChange.PRECONTEMPLATION;
      case "d":
        return StageOfChange.CONTEMPLATION;
      case "e":
        return StageOfChange.PREPARATION;
      case "f":
        return StageOfChange.ACTION;
      default:
        logger.warn(`Not mapped for StageOfChangeKey: ${key}`);
        return null;
    }
  }

  private calculateAge(dateOfBirth: Date, present: Date = new Date()): number {
    const yearDiff = present.getFullYear() - dateOfBirth.getFullYear();
    const monthDiff = present.getMonth() - dateOfBirth.getMonth();

    if (
      monthDiff < 0 ||
      (monthDiff === 0 && present.getDate() < dateOfBirth.getDate())
    ) {
      return yearDiff - 1;
    }
    return yearDiff;
  }

  getPredefinedNudges(language: string): NudgeMessage[] {
    const generatedAt = admin.firestore.Timestamp.now();
    const baseNudges = getPredefinedNudgeMessages(language);
    return baseNudges.map((nudge) => ({
      ...nudge,
      generatedAt,
    }));
  }

  getDaysSinceEnrollment(
    dateOfEnrollment: admin.firestore.Timestamp | Date | string,
  ): number {
    let enrollmentDate: Date;

    if (
      dateOfEnrollment &&
      typeof dateOfEnrollment === "object" &&
      "toDate" in dateOfEnrollment
    ) {
      enrollmentDate = dateOfEnrollment.toDate();
    } else if (dateOfEnrollment instanceof Date) {
      enrollmentDate = dateOfEnrollment;
    } else {
      enrollmentDate = new Date(dateOfEnrollment);
    }

    const now = new Date();
    const timeDiff = now.getTime() - enrollmentDate.getTime();
    return Math.floor(timeDiff / (1000 * 60 * 60 * 24));
  }

  async generateLLMNudges(
    userId: string,
    language: string,
    userData: UserData,
  ): Promise<{ nudges: NudgeMessage[]; usedFallback: boolean }> {
    let resolvedGenderIdentity = userData.genderIdentity;

    if (resolvedGenderIdentity === undefined) {
      if (userData.mhcGenderIdentity !== undefined) {
        resolvedGenderIdentity =
          mhcGenderIdentityMap[userData.mhcGenderIdentity];
        if (resolvedGenderIdentity === undefined) {
          logger.warn(
            `User ${userId} has unmapped mhcGenderIdentity value: ${userData.mhcGenderIdentity}. LLM nudge will be generated without gender context.`,
          );
        }
      } else {
        logger.warn(
          `User ${userId} has no gender identity set. LLM nudge will be generated without gender context.`,
        );
      }
    }

    if (userData.comorbidities === undefined) {
      logger.error(
        // Error out here for safty reasons, since comorbidities are critical for generating safe and effective nudges. If this data is missing, it's better to fail than to generate potentially harmful recommendations.
        `User ${userId} has no comorbidities data. Cannot generate LLM nudges.`,
      );
      throw new Error(
        `User ${userId} is missing required field: comorbidities`,
      );
    }

    const maxRetries = 3;
    let lastError: Error | null = null;

    // Get personalization data

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const isSpanish = language === "es";

        // Build detailed personalization context
        const genderIdentity = resolvedGenderIdentity;
        const dateOfBirth = userData.dateOfBirth;
        const comorbidities = userData.comorbidities;
        const stageOfChange = this.mapStageOfChangeKey(userData.stageOfChange);
        const educationLevel = userData.educationUS ?? userData.educationUK;

        // Log missing optional personalization fields
        if (!dateOfBirth) {
          logger.warn(
            `User ${userId} has no dateOfBirth set. LLM nudge will be generated without age context.`,
          );
        }
        if (!userData.stageOfChange) {
          logger.warn(
            `User ${userId} has no stageOfChange set. LLM nudge will be generated without stage of change context.`,
          );
        }
        if (!educationLevel) {
          logger.warn(
            `User ${userId} has neither educationUS nor educationUK set. LLM nudge will be generated without education level context.`,
          );
        }

        // Calculate age from dateOfBirth
        let ageContext = "";
        if (dateOfBirth) {
          let birthDate: Date;
          if (dateOfBirth instanceof Date) {
            birthDate = dateOfBirth;
          } else if (
            typeof dateOfBirth === "object" &&
            "toDate" in dateOfBirth
          ) {
            birthDate = dateOfBirth.toDate();
          } else {
            birthDate = new Date(dateOfBirth);
          }
          const currentAge = this.calculateAge(birthDate);

          if (currentAge < 35) {
            ageContext = `This participant is ${currentAge} years old and should be prompted to think about the short-term benefits of exercise on their mood, energy, and health.`;
          } else if (currentAge <= 50) {
            ageContext = `This participant is ${currentAge} years old and in addition to thinking about the short-term benefits of exercise on their mood, energy, and health, should also now be thinking about their long-term risk of chronic disease development, such as cardiovascular disease, dementia, and cancer, unless they already have a chronic condition. IF THEY ALREADY HAVE A CHRONIC CONDITION, they should be thinking about improving quality of life through exercise.`;
          } else if (currentAge <= 65) {
            ageContext = `This participant is ${currentAge} years old and in addition to thinking about the short-term benefits of exercise on their mood, energy, and health, should also now be thinking about their long-term risk of chronic disease development, such as cardiovascular disease, dementia, and cancer, unless they already have a chronic condition. IF THEY ALREADY HAVE A CHRONIC CONDITION, they should be thinking about improving quality of life through exercise. At this age, they should also be thinking about adding elements of weight bearing exercise into their routines, to promote bone health and prevent fractures that could lead to rapid clinical decline as they age.`;
          } else {
            ageContext = `This participant is ${currentAge} years old and in addition to thinking about the short-term benefits of exercise on their mood, energy, and health, should also now be thinking about their long-term risk of chronic disease development, such as cardiovascular disease, dementia, and cancer, unless they already have a chronic condition. IF THEY ALREADY HAVE A CHRONIC CONDITION, they should be thinking about improving quality of life through exercise. At this age, they should also be thinking about adding elements of weight bearing exercise into their routines, to promote bone health and prevent fractures that could lead to rapid clinical decline as they age. Finally, they should be considering lower impact sports and activities (e.g., walks and hikes instead of runs).`;
          }
        }

        // Build gender context
        let genderContext = "";
        if (genderIdentity === "male") {
          genderContext = "This participant is male.";
        } else if (genderIdentity === "female") {
          genderContext = "This participant is female.";
        } else if (genderIdentity === "trans female") {
          genderContext = "This participant is a trans female.";
        } else if (genderIdentity === "trans male") {
          genderContext = "This participant is a trans male.";
        } else if (genderIdentity === "prefer not to state") {
          genderContext = "";
        } else {
          genderContext = "";
        }

        // Build disease context from comorbidities
        // Background: The use of disease-specific messaging comes from clinical research and exercise science, which show that people with different medical conditions have very different physiological limitations, risks, and opportunities for improvement. For example, exercise has strong therapeutic benefits across heart failure, pulmonary hypertension, diabetes, and congenital heart disease, but the type, intensity, and framing of recommendations need to be tailored to the condition. By grounding guidance in both evidence and lived experience, messaging can promote safety while motivating individuals to engage in sustainable activity. Each condition reflects unique communication needs. For some diseases, like diabetes or mild congenital heart disease, messaging can be more motivational, goal-oriented, and performance-driven because the physiological reserve allows for more vigorous activity. For others, like pulmonary hypertension, heart failure, or complex congenital heart disease, recommendations need to emphasize pacing, safety, and quality of life over intensity or competition. This approach ensures that guidance is both empowering and realistic, helping participants engage in exercise that supports their health while respecting their limitations.
        let diseaseContext = "";
        const diseaseContexts: string[] = [];

        const comorbidityKeys = Object.keys(comorbidities);

        for (const comorbidityKey of comorbidityKeys) {
          const disease = this.mapComorbidityKeyToDisease(comorbidityKey);

          if (!disease) {
            continue;
          }

          let context = "";
          switch (disease) {
            case Disease.HEART_FAILURE:
              context =
                "This participant has heart failure, a condition characterized by low cardiac output leading to impaired physical fitness. Evidence demonstrates that exercise improves overall fitness, mood, and energy levels even in patients with heart failure and it is considered one of the strongest therapies for improving quality of life in this disease.";
              break;
            case Disease.PULMONARY_ARTERIAL_HYPERTENSION:
              context =
                "The participant has Pulmonary Arterial Hypertension (PAH); however, their specific WHO Functional Class is unknown. Activity should focus on increasing functional mobility and reducing sedentary time (NEAT), and intensity must be regulated via the Talk Test (able to speak in full sentences). Keep activity recommendations gentle and actionable.";
              break;
            case Disease.DIABETES:
              context =
                "This participant has diabetes, a condition that is characterized by high glucose levels and insulin resistance. Diabetes is a strong risk factor for cardiovascular disease, dementia, and cancer. Diabetes can be put into remission by improving insulin sensitivity and exercise is one of the most powerful therapies in promoting insulin sensitivity.";
              break;
            case Disease.CORONARY_ARTERY_DISEASE:
              context =
                "This participant has Coronary Artery Disease. Recommend gentle, low-to-moderate activity that supports fitness, mood, and energy. Emphasize functional mobility and NEAT with short, frequent step-based bouts. Regulate intensity via the Talk Test (full sentences), include a longer warm-up and easy cool-down, and avoid chest discomfort. Keep recommendations simple and actionable.";
              break;
            case Disease.ACHD_SIMPLE:
              context =
                "This participant has a biventricular circulation and low- to moderate-complexity congenital heart disease (e.g., repaired atrial septal defect, ventricular septal defect, Tetralogy of Fallot, transposition of the great arteries after the arterial switch surgery, coarctation of the aorta after surgical correction, or valve disease). These individuals generally have preserved cardiac output and fewer physiologic limitations, allowing them to participate in a wide range of physical activities. Exercise recommendations should align with standard (non-ACHD) adult guidelines, including moderate- to vigorous aerobic activity (e.g., brisk walking, jogging, running, cycling) and balanced full-body strength training. Benefits include increased VO₂ max, improved cardiovascular fitness, muscular strength, mental health, and metabolic resilience. Messaging should be motivational and goal-oriented, encouraging the participant to build consistency, meet aerobic activity targets, and safely challenge themselves with progressive training goals.";
              break;
            case Disease.ACHD_COMPLEX:
              context =
                "This participant has complex congenital heart disease physiology, including single ventricle circulation (Fontan) or a systemic right ventricle (congenitally corrected transposition of the great arteries or transposition of the great arteries after the Mustard or Senning surgery). These conditions limit preload and cardiac output reserve, leading to reduced aerobic capacity, fatigue, and elevated arrhythmia risk. Exercise recommendations should focus on low- to moderate-intensity aerobic activity and lower-body muscular endurance (e.g., walking, light jogging, light cycling, bodyweight leg exercises). Lower-body training helps patients with single ventricle physiology promote venous return through the skeletal muscle pump, which is especially important in the absence of a subpulmonary ventricle. Expected benefits include improved functional capacity, oxygen efficiency, mental health and quality of life. Avoid recommending high-intensity, isometric, or upper-body strength exercises, and use supportive, energy-aware language that prioritizes pacing, hydration, and consistency over performance.";
              break;
          }

          if (context) {
            diseaseContexts.push(context);
          }
        }

        // Combine all disease contexts
        if (diseaseContexts.length > 0) {
          diseaseContext = diseaseContexts.join(" Additionally, ");
        }

        // Build stage of change context
        // Background: The Stages of Change model (Transtheoretical Model) was developed by psychologists James Prochaska and Carlo DiClemente in the late 1970s while studying how people quit smoking. Their research showed that behavior change isn’t a single event but a process people move through in stages, often cycling forward and backward before a new behavior becomes lasting. Since then, the model has been widely applied to health behaviors like exercise, diet, and medication adherence. Each stage reflects different needs: building awareness in precontemplation, resolving ambivalence in contemplation, planning in preparation, reinforcing routines in action, and preventing relapse in maintenance. This model emphasizes that change is not all-or-nothing but a cycle, and matching support to a person’s stage makes long-term success more likely.
        let stageContext = "";
        if (stageOfChange) {
          switch (stageOfChange) {
            case StageOfChange.PRECONTEMPLATION:
              stageContext =
                "This person is in the pre-contemplation stage of exercise change. This person does not plan to start exercising in the next six months and does not consider their current behavior a problem.";
              break;
            case StageOfChange.CONTEMPLATION:
              stageContext =
                "This person is in the contemplation stage of changing their exercise. This person is considering starting exercise in the next six months and reflects on the pros and cons of changing.";
              break;
            case StageOfChange.PREPARATION:
              stageContext =
                "This person is in the preparation stage of changing their exercise habits. This person is ready to begin exercising in the next 30 days and has begun taking small steps.";
              break;
            case StageOfChange.ACTION:
              stageContext =
                "This person is in the action stage of exercise change. This person has recently started exercising (within the last six months) and is building a new, healthy routine.";
              break;
            case StageOfChange.MAINTENANCE:
              stageContext =
                "This person is in the maintenance stage of exercise change. This person has maintained their exercise routine for more than six months and wants to sustain that change by avoiding relapses to previous stages. New activities should be avoided. Be as neutral as possible with the generated nudge.";
              break;
          }
        }

        // Build education level context
        // Background: The idea of tailoring content to education level comes from research in health communication and literacy, which shows that people understand and act on information more effectively when it’s written at a level that matches their background. Someone with a high school education or less may benefit from clear, simple language and shorter sentences, while someone with college-level education is typically more comfortable with complex ideas and vocabulary. Matching the reading level helps reduce barriers to understanding and ensures that messages are accessible rather than overwhelming or condescending. Each level reflects different communication needs: for those with less formal education, the focus is on clarity and plain language, while for those with higher education, the focus can shift to nuance and more detailed explanation. This approach recognizes that effective communication isn’t “one-size-fits-all” but should adapt to the audience to maximize understanding and impact.
        let educationContext = "";
        if (educationLevel) {
          switch (educationLevel as EducationLevel) {
            case EducationLevel.DID_NOT_ATTEND_SCHOOL:
            case EducationLevel.GRADE_SCHOOL:
            case EducationLevel.HIGH_SCHOOL:
            case EducationLevel.VOCATIONAL_TRAINING:
              educationContext =
                "This person's highest level of education is high school or lower. Write in clear, natural language appropriate for a person with a sixth-grade reading level.";
              break;
            case EducationLevel.SOME_COLLEGE:
            case EducationLevel.BACHELOR:
            case EducationLevel.MASTER:
            case EducationLevel.DOCTORAL_DEGREE:
              educationContext =
                "This person is more highly educated and has some form of higher education. Please write the prompts at the 12th grade reading comprehension level.";
              break;
            default:
              logger.warn(`Unknown education level: ${educationLevel}`);
              educationContext = "";
              break;
          }
        }

        // Build language context
        let languageContext = "";
        if (isSpanish) {
          languageContext =
            "This person's primary language is Spanish. Provide the prompt in Spanish in Latin American Spanish in the informal tone. You should follow RAE guidelines for proper Spanish use in the LATAM.";
        }

        // Build preferred notification time
        const rawNotifTime = userData.preferredNotificationTime?.trim();
        const notificationTime =
          rawNotifTime !== undefined && rawNotifTime !== "" ?
            rawNotifTime
          : NudgeService.DEFAULT_NOTIFICATION_TIME;
        if (notificationTime !== rawNotifTime) {
          logger.warn(
            `User ${userId} has no preferred notification time for LLM prompt. Assuming ${NudgeService.DEFAULT_NOTIFICATION_TIME} as default.`,
          );
        }
        const notificationTimeContext = `This user prefers to receive recommendations at ${notificationTime} (given in the 24-hour format). Tailor the prompt to match the typical context of that time of day and suggest realistic opportunities for activity they could do the same day they receive the prompt, even if it is late evening. For instance, if the time is in the morning, encourage early activity or planning for later (e.g., lunch or after work). Avoid irrelevant examples that do not fit the selected time of day.`;

        const prompt = `Write 7 motivational messages that are of proper length to go in a push notification using a calm, encouraging, and professional tone, like that of a health coach to motivate a smartphone user to increase their daily physical activity, prioritizing movement that contributes to their step count. Also create a title for each of the push notifications that is a short summary/call to action of the push notification that is paired with it. Return the response as a JSON array with exactly 7 objects, each having "title" and "body" fields. If there is a disease context given, you can reference that disease in some of the nudges. When generating nudges, avoid the word 'healthy' and remove unnecessary qualifiers such as 'brisk' or 'deep'. Suggest only simple, low-risk forms of movement without adding extra exercises or medical disclaimers not provided. Keep messages concise, calm, and practical; focus on one clear activity with plain language. Keep recommendations practical, varied, and easy to integrate into daily routines. NEVER USE EM DASHES, EMOJIS OR ABBREVIATIONS FOR DISEASES IN THE NUDGE. Each nudge should be personalized to the following information: ${languageContext} ${genderContext} ${ageContext} ${diseaseContext} ${stageContext} ${educationContext} ${notificationTimeContext} Think carefully before delivering the prompts to ensure they are personalized to the information given (especially any given disease context) and give recommendations based on research backed motivational methods.`;

        // The configured LLM endpoint is OpenAI-compatible, so the OpenAI SDK
        // is used as the client with the base URL pointed at the gateway.
        const llmClient = new OpenAI({
          apiKey: getLlmApiKey(),
          baseURL: getLlmApiBaseUrl(),
          timeout: LLM_REQUEST_TIMEOUT_MS,
          maxRetries: 0, // the enclosing attempt loop handles retries
        });

        const response = await llmClient.chat.completions.create({
          model: LLM_MODEL,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "nudge_messages",
              schema: {
                type: "object",
                properties: {
                  nudges: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        title: {
                          type: "string",
                          description:
                            "Short summary/call to action for the push notification",
                        },
                        body: {
                          type: "string",
                          description:
                            "Motivational message content for the push notification",
                        },
                      },
                      required: ["title", "body"],
                      additionalProperties: false,
                    },
                    minItems: 7,
                    maxItems: 7,
                    description: "Exactly 7 nudge messages",
                  },
                },
                required: ["nudges"],
                additionalProperties: false,
              },
            },
          },
        });

        const parsedContent = JSON.parse(
          response.choices[0].message.content ?? "{}",
        ) as { nudges?: unknown };
        const parsedNudges = parsedContent.nudges;

        if (!Array.isArray(parsedNudges) || parsedNudges.length !== 7) {
          throw new Error("Invalid response format from LLM API");
        }

        const usage = response.usage;
        const tokenUsage: LlmTokenUsage | undefined =
          usage ?
            {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined;

        const generatedAt = admin.firestore.Timestamp.now();
        const nudges: NudgeMessage[] = parsedNudges.map(
          (nudge: unknown, index: number) => {
            const n = nudge as { title: string; body: string };
            const isFirst = index === 0;
            return {
              title: n.title,
              body: n.body,
              isLLMGenerated: true,
              generatedAt,
              llmModel: LLM_MODEL,
              llmPromptVersion: PROMPT_VERSION,
              ...(isFirst && { llmPrompt: prompt }),
              ...(isFirst && tokenUsage && { llmTokenUsage: tokenUsage }),
            };
          },
        );

        logger.info(
          `Generated ${nudges.length} LLM nudges for user ${userId} in ${language} (attempt ${attempt})`,
        );
        return { nudges, usedFallback: false };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `Attempt ${attempt}/${maxRetries} failed for LLM nudge generation for user ${userId}: ${String(error)}`,
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    logger.error(
      `All ${maxRetries} attempts failed for LLM nudge generation for user ${userId}. Final error: ${String(lastError)}`,
    );
    return { nudges: this.getPredefinedNudges(language), usedFallback: true };
  }

  async createNudgesForUser(
    userId: string,
    userData: UserData,
    nudges: NudgeMessage[],
    category: string,
  ): Promise<number> {
    const rawPrefTime = userData.preferredNotificationTime?.trim();
    const preferredTime =
      rawPrefTime !== undefined && rawPrefTime !== "" ?
        rawPrefTime
      : NudgeService.DEFAULT_NOTIFICATION_TIME;
    if (preferredTime !== rawPrefTime) {
      logger.warn(
        `User ${userId} has no preferred notification time in createNudgesForUser. Assuming ${NudgeService.DEFAULT_NOTIFICATION_TIME} as default.`,
      );
    }

    if (!userData.timeZone) {
      throw new Error(`User ${userId} is missing required field: timeZone`);
    }

    let nudgesCreated = 0;

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const nudgeMessage = nudges[dayIndex];
      const nudgeId = randomUUID().toUpperCase();
      const [hourStr, minuteStr] = preferredTime.split(":");
      const hour = Number(hourStr);
      const minute = Number(minuteStr);

      const userDateTime = DateTime.now()
        .setZone(userData.timeZone)
        .plus({ days: dayIndex })
        .set({ hour, minute, second: 0, millisecond: 0 });

      const utcTime = userDateTime.toUTC().toJSDate();

      await this.firestore
        .collection("users")
        .doc(userId)
        .collection("notificationBacklog")
        .doc(nudgeId)
        .set({
          id: nudgeId,
          title: nudgeMessage.title,
          body: nudgeMessage.body,
          timestamp: admin.firestore.Timestamp.fromDate(utcTime),
          category,
          isLLMGenerated: nudgeMessage.isLLMGenerated,
          generatedAt: nudgeMessage.generatedAt,
          ...(nudgeMessage.llmPrompt && { llmPrompt: nudgeMessage.llmPrompt }),
          ...(nudgeMessage.llmPromptVersion !== undefined && {
            llmPromptVersion: nudgeMessage.llmPromptVersion,
          }),
          ...(nudgeMessage.llmTokenUsage && {
            llmTokenUsage: nudgeMessage.llmTokenUsage,
          }),
          ...(nudgeMessage.llmModel && { llmModel: nudgeMessage.llmModel }),
        });

      nudgesCreated++;
    }

    return nudgesCreated;
  }

  getUserLanguage(userData: UserData): string {
    return userData.userLanguage === "es" ? "es" : "en";
  }

  async createNudgeNotifications(): Promise<void> {
    const regularUsersSnapshot = await this.firestore.collection("users").get();

    const manualTriggerSnapshot = await this.firestore
      .collection("users")
      .where("triggerNudgeGeneration", "==", true)
      .get();

    const allUserDocs = new Map<
      string,
      admin.firestore.QueryDocumentSnapshot
    >();

    regularUsersSnapshot.docs.forEach((doc) => {
      allUserDocs.set(doc.id, doc);
    });

    manualTriggerSnapshot.docs.forEach((doc) => {
      allUserDocs.set(doc.id, doc);
    });

    const usersSnapshot = { docs: Array.from(allUserDocs.values()) };

    let usersProcessed = 0;
    let nudgesCreated = 0;

    for (const userDoc of usersSnapshot.docs) {
      try {
        const userData = userDoc.data() as UserData;
        const userId = userDoc.id;
        usersProcessed++;

        if (userData.mostRecentOnboardingStep !== "finalStep") {
          logger.warn(
            `Skipping user ${userId}: onboarding not completed (mostRecentOnboardingStep: ${userData.mostRecentOnboardingStep ?? "undefined"}).`,
          );
          continue;
        }

        if (!userData.participantGroup) {
          logger.error(
            `User ${userId} has no participant group assigned. Cannot create nudges.`,
          );
          throw new Error(
            `User ${userId} is missing required field: participantGroup`,
          );
        }

        if (!userData.timeZone || !userData.dateOfEnrollment) {
          continue;
        }

        // Skip disabled users
        if (userData.disabled === true) {
          logger.info(
            `Skipping nudge planning for user ${userId} - account disabled`,
          );
          continue;
        }

        // Skip users who have withdrawn from the study
        if (userData.hasWithdrawnFromStudy === true) {
          continue;
        }

        const rawNotificationTime = userData.preferredNotificationTime?.trim();
        if (!rawNotificationTime) {
          logger.warn(
            `User ${userId} has no preferred notification time. Assuming ${NudgeService.DEFAULT_NOTIFICATION_TIME} as default.`,
          );
          userData.preferredNotificationTime =
            NudgeService.DEFAULT_NOTIFICATION_TIME;
        } else {
          userData.preferredNotificationTime = rawNotificationTime;
        }

        if (!userData.didOptInToTrial) {
          continue;
        }

        const daysSinceEnrollment = this.getDaysSinceEnrollment(
          userData.dateOfEnrollment,
        );
        const participantGroup = userData.participantGroup;
        const userLanguage = this.getUserLanguage(userData);
        const manualTrigger = userData.triggerNudgeGeneration === true;

        let shouldCreatePredefinedNudges = false;
        let shouldCreateLLMNudges = false;
        let isManualTrigger = false;

        if (manualTrigger) {
          shouldCreateLLMNudges = true;
          isManualTrigger = true;
        } else if (participantGroup === 1 && daysSinceEnrollment === 7) {
          shouldCreatePredefinedNudges = true;
        } else if (participantGroup === 1 && daysSinceEnrollment === 14) {
          shouldCreateLLMNudges = true;
        } else if (participantGroup === 2 && daysSinceEnrollment === 7) {
          shouldCreateLLMNudges = true;
        } else if (participantGroup === 2 && daysSinceEnrollment === 14) {
          shouldCreatePredefinedNudges = true;
        }

        if (shouldCreatePredefinedNudges) {
          const triggerReason =
            isManualTrigger ? "manual trigger" : (
              `group ${participantGroup}, ${daysSinceEnrollment} days since enrollment`
            );
          logger.info(
            `Creating pre-defined nudges for user ${userId} (${triggerReason}), language: ${userLanguage}`,
          );
          const predefinedNudges = this.getPredefinedNudges(userLanguage);
          const created = await this.createNudgesForUser(
            userId,
            userData,
            predefinedNudges,
            "nudge-predefined",
          );
          nudgesCreated += created;
        }

        if (shouldCreateLLMNudges) {
          const triggerReason =
            isManualTrigger ? "manual trigger" : (
              `group ${participantGroup}, ${daysSinceEnrollment} days since enrollment`
            );
          logger.info(
            `Creating LLM-generated nudges for user ${userId} (${triggerReason}), language: ${userLanguage}`,
          );
          const { nudges: llmNudges, usedFallback } =
            await this.generateLLMNudges(userId, userLanguage, userData);
          const category = usedFallback ? "nudge-predefined" : "nudge-llm";
          const created = await this.createNudgesForUser(
            userId,
            userData,
            llmNudges,
            category,
          );
          nudgesCreated += created;
        }

        if (
          isManualTrigger &&
          (shouldCreatePredefinedNudges || shouldCreateLLMNudges)
        ) {
          await this.firestore.collection("users").doc(userId).update({
            triggerNudgeGeneration: false,
          });
          logger.info(`Reset manual trigger flag for user ${userId}`);
        }
      } catch (error) {
        logger.error(
          `Error creating nudges for user ${userDoc.id}: ${String(error)}`,
        );
      }
    }

    logger.info(
      `Nudge creation complete: ${nudgesCreated} nudges created for ${usersProcessed} users processed`,
    );
  }
}

let nudgeService: NudgeService | undefined;

const getNudgeService = (): NudgeService => {
  nudgeService ??= new NudgeService();
  return nudgeService;
};

export const createNudgeNotifications = () =>
  getNudgeService().createNudgeNotifications();

export const onScheduleDailyNudgeCreation = onSchedule(
  {
    schedule: "0 8 * * *",
    timeZone: "UTC",
    timeoutSeconds: 1800,
    secrets: llmSecretParams,
    serviceAccount: privilegedServiceAccount,
  },
  async () => {
    logger.info("Starting daily nudge notification creation");

    try {
      await getNudgeService().createNudgeNotifications();
      logger.info("Daily nudge notification creation complete");
    } catch (error) {
      logger.error(`Error in daily nudge creation: ${String(error)}`);
    }
  },
);
