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
import { type BaseNudgeMessage } from "./nudgeMessages.js";

interface PosttrialUserData {
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
  didOptInToTrial?: boolean;
  userLanguage?: string;
  disabled?: boolean;
  hasWithdrawnFromStudy?: boolean;
  mostRecentOnboardingStep?: string;
  extendedActivityNudgesOptIn?: boolean;
  preferredWorkoutTypes?: string;
  lastActiveDate?: Date | string | admin.firestore.Timestamp;
  posttrialWelcomeNudgeScheduled?: boolean;
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

const AVAILABLE_WORKOUT_TYPES = [
  "other",
  "HIIT",
  "walk",
  "swim",
  "run",
  "sport",
  "strength",
  "bicycle",
  "yoga/pilates",
] as const;

// Model ID as exposed by the configured LLM API gateway.
const LLM_MODEL = "gpt-5-mini";

const LLM_REQUEST_TIMEOUT_MS = 60_000;

// Version of the LLM prompt template built in generateLLMNudge. Bump this
// whenever the prompt wording changes so generated nudges can be traced back
// to the exact prompt version that produced them.
const PROMPT_VERSION = "1.0.0";

interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface PosttrialNudgeMessage extends BaseNudgeMessage {
  generatedAt: admin.firestore.Timestamp;
  llmPrompt?: string;
  llmPromptVersion?: string;
  llmTokenUsage?: LlmTokenUsage;
  llmModel?: string;
}

export class PosttrialNudgeService {
  // Properties

  private static readonly DEFAULT_NOTIFICATION_TIME = "09:00";
  private static readonly TRIAL_COMPLETION_DAYS = 21;
  private static readonly ACTIVE_WINDOW_DAYS = 14;
  private static readonly CATEGORY = "nudge-posttrial";
  private static readonly WELCOME_CATEGORY = "nudge-posttrial-welcome";
  private static readonly WELCOME_TITLE = "Physical Activity Nudges Extended";
  private static readonly WELCOME_BODY =
    "Daily nudges for your preferred activities continue after trial! Manage anytime in Profile/Settings under long-term nudges toggle.";
  private static readonly WELCOME_TITLE_ES =
    "Empujoncitos de actividad física extendidos";
  private static readonly WELCOME_BODY_ES =
    "¡Los empujoncitos diarios para tus actividades preferidas continúan después del período de prueba! Puedes administrarlos en cualquier momento en Perfil/Configuración bajo el interruptor de empujoncitos a largo plazo.";
  private static readonly WELCOME_LEAD_MS = 60 * 60 * 1000;
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

  private getDaysSinceEnrollment(
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

  private isWithinActiveWindow(
    lastActiveDate: admin.firestore.Timestamp | Date | string | undefined,
  ): boolean {
    if (!lastActiveDate) return false;

    let date: Date;
    if (typeof lastActiveDate === "object" && "toDate" in lastActiveDate) {
      date = lastActiveDate.toDate();
    } else if (lastActiveDate instanceof Date) {
      date = lastActiveDate;
    } else {
      date = new Date(lastActiveDate);
    }

    const cutoff =
      Date.now() -
      PosttrialNudgeService.ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    return date.getTime() >= cutoff;
  }

  private computeTargetUtc(timeZone: string, preferredTime: string): Date {
    const [hourStr, minuteStr] = preferredTime.split(":");
    const hour = Number(hourStr);
    const minute = Number(minuteStr);

    const nowLocal = DateTime.now().setZone(timeZone);
    let target = nowLocal.set({
      hour,
      minute,
      second: 0,
      millisecond: 0,
    });
    if (target <= nowLocal) {
      target = target.plus({ days: 1 });
    }
    return target.toUTC().toJSDate();
  }

  private async hasNudgeForLocalDay(
    userId: string,
    targetUtc: Date,
    timeZone: string,
  ): Promise<boolean> {
    const targetLocalDay = DateTime.fromJSDate(targetUtc)
      .setZone(timeZone)
      .toISODate();
    const snap = await this.firestore
      .collection("users")
      .doc(userId)
      .collection("notificationBacklog")
      .where("category", "==", PosttrialNudgeService.CATEGORY)
      .get();
    return snap.docs.some((doc) => {
      const data = doc.data();
      const ts = data.timestamp as admin.firestore.Timestamp | undefined;
      if (!ts) return false;
      return (
        DateTime.fromJSDate(ts.toDate()).setZone(timeZone).toISODate() ===
        targetLocalDay
      );
    });
  }

  async getRecentPosttrialNudgeBodies(
    userId: string,
    beforeUtc: Date,
    limit = 3,
  ): Promise<string[]> {
    const userRef = this.firestore.collection("users").doc(userId);

    // Posttrial nudges live in `notificationBacklog` until delivery, then
    // sendNudges archives them to `notificationHistory` (with `timestamp`
    // renamed to `originalTimestamp`) and deletes the backlog doc. Read
    // both so the LLM sees already-delivered nudges, not just upcoming ones.
    const [backlogSnap, historySnap] = await Promise.all([
      userRef
        .collection("notificationBacklog")
        .where("category", "==", PosttrialNudgeService.CATEGORY)
        .get(),
      userRef
        .collection("notificationHistory")
        .where("category", "==", PosttrialNudgeService.CATEGORY)
        .orderBy("originalTimestamp", "desc")
        .limit(limit * 3)
        .get(),
    ]);

    const beforeMs = beforeUtc.getTime();
    const byId = new Map<string, { body: string; ms: number }>();

    const consider = (
      id: string,
      body: string | undefined,
      ts: admin.firestore.Timestamp | undefined,
    ): void => {
      if (!ts || !body) return;
      const ms = ts.toDate().getTime();
      if (ms >= beforeMs) return;
      if (byId.has(id)) return;
      byId.set(id, { body, ms });
    };

    // History wins on the rare overlap: sendNudges writes the archive doc
    // before deleting the backlog doc, so a fired-but-not-yet-cleaned entry
    // briefly exists in both. The history copy is authoritative.
    for (const doc of historySnap.docs) {
      const data = doc.data();
      consider(
        doc.id,
        data.body as string | undefined,
        data.originalTimestamp as admin.firestore.Timestamp | undefined,
      );
    }
    for (const doc of backlogSnap.docs) {
      const data = doc.data();
      consider(
        doc.id,
        data.body as string | undefined,
        data.timestamp as admin.firestore.Timestamp | undefined,
      );
    }

    const entries = Array.from(byId.values());
    entries.sort((a, b) => b.ms - a.ms);
    return entries
      .slice(0, limit)
      .map((entry) => entry.body)
      .reverse();
  }

  async generateLLMNudge(
    userId: string,
    language: string,
    userData: PosttrialUserData,
    targetUtc: Date,
  ): Promise<PosttrialNudgeMessage | null> {
    let resolvedGenderIdentity = userData.genderIdentity;

    if (resolvedGenderIdentity === undefined) {
      if (userData.mhcGenderIdentity !== undefined) {
        resolvedGenderIdentity =
          mhcGenderIdentityMap[userData.mhcGenderIdentity];
        if (resolvedGenderIdentity === undefined) {
          logger.error(
            `User ${userId} has unmapped mhcGenderIdentity value: ${userData.mhcGenderIdentity}. Cannot generate post-trial LLM nudge.`,
          );
          return null;
        }
      } else {
        logger.error(
          `User ${userId} has no gender identity. Cannot generate post-trial LLM nudge.`,
        );
        return null;
      }
    }

    if (userData.comorbidities === undefined) {
      logger.error(
        `User ${userId} has no comorbidities data. Cannot generate post-trial LLM nudge.`,
      );
      return null;
    }

    const educationLevel = userData.educationUS ?? userData.educationUK;
    if (!educationLevel) {
      logger.warn(
        `User ${userId} has neither educationUS nor educationUK set. Post-trial LLM nudge will be generated without education level context.`,
      );
    }

    const recentNudgeBodies = await this.getRecentPosttrialNudgeBodies(
      userId,
      targetUtc,
    );

    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const isSpanish = language === "es";

        // Build detailed personalization context
        const genderIdentity = resolvedGenderIdentity;
        const dateOfBirth = userData.dateOfBirth;
        const comorbidities = userData.comorbidities;
        const stageOfChange = this.mapStageOfChangeKey(userData.stageOfChange);

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

        if (diseaseContexts.length > 0) {
          diseaseContext = diseaseContexts.join(" Additionally, ");
        }

        // Build stage of change context
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
          : PosttrialNudgeService.DEFAULT_NOTIFICATION_TIME;
        if (notificationTime !== rawNotifTime) {
          logger.warn(
            `User ${userId} has no preferred notification time for post-trial LLM prompt. Assuming ${PosttrialNudgeService.DEFAULT_NOTIFICATION_TIME} as default.`,
          );
        }
        const notificationTimeContext = `This user prefers to receive recommendations at ${notificationTime} (given in the 24-hour format). Tailor the prompt to match the typical context of that time of day and suggest realistic opportunities for activity they could do the same day they receive the prompt, even if it is late evening. For instance, if the time is in the morning, encourage early activity or planning for later (e.g., lunch or after work). Avoid irrelevant examples that do not fit the selected time of day.`;

        // Build preferred workout types context (ported from historical
        // planNudges implementation; see git commits b816a86d / 3e426d75 /
        // 7d5c767f). This is post-trial-only personalization.
        let activityTypeContext = "";
        if (userData.preferredWorkoutTypes) {
          const selectedTypes = userData.preferredWorkoutTypes
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
          const hasOther = selectedTypes.includes("other");
          const selectedActivities = selectedTypes.filter((t) => t !== "other");
          const formattedSelectedTypes =
            selectedActivities.length > 0 ?
              selectedActivities.join(", ")
            : "various activities";

          activityTypeContext = `${formattedSelectedTypes} are the user's preferred activity types. Recommendations should be centered around these activity types. Recommendations should be creative, encouraging, and aligned with their preferred activity type.`;

          if (hasOther) {
            const notChosenTypes = AVAILABLE_WORKOUT_TYPES.filter(
              (t) => t !== "other" && !selectedTypes.includes(t),
            );
            if (selectedActivities.length === 0) {
              activityTypeContext = `The user indicated that their preferred activity types differ from the available options (${AVAILABLE_WORKOUT_TYPES.filter((t) => t !== "other").join(", ")}). Provide creative recommendations and suggest other ways to stay physically active without relying on the listed options.`;
            } else if (notChosenTypes.length > 0) {
              activityTypeContext += ` The user indicated that they also prefer activity types beyond the remaining options (${notChosenTypes.join(", ")}). Provide creative recommendations and suggest other ways to stay physically active.`;
            } else {
              activityTypeContext += ` The user indicated additional preferred activity types beyond the listed options. Provide creative recommendations and suggest other ways to stay physically active.`;
            }
          }
        }

        // Build previous-nudges context: feed the LLM up to 3 of the user's
        // most recent posttrial nudge bodies so it can vary tone and avoid
        // repetition. Empty when no prior nudges exist (e.g. first day).
        let previousNudgesContext = "";
        let varietyClause = "";
        if (recentNudgeBodies.length > 0) {
          const formattedNudges = recentNudgeBodies
            .map((body) => `- ${JSON.stringify(body)}`)
            .join("\n");
          previousNudgesContext =
            `The nudge for today should be unique in tone and motivational style from the past ${recentNudgeBodies.length} days and should not sound repetitive. ` +
            `These are the nudges that were given to this user over the past ${recentNudgeBodies.length} days:\n${formattedNudges}`;
          varietyClause =
            " and make sure that it is different in overall style from the previously delivered nudges";
        }

        // Prompt: Just one nudge, include personalization context.
        const prompt = `Write 1 motivational message that is a proper length to go in a push notification using a calm, encouraging, and professional tone, like that of a health coach to motivate a smartphone user to increase their daily physical activity. Also create a title for the push notification that is a short summary/call to action of the push notification. Return the response as a JSON object with 'title' and 'body' fields. If there is a disease context given, you can reference that disease in the nudge. When generating the nudge, avoid the word 'healthy' and remove unnecessary qualifiers such as 'brisk' or 'deep'. Suggest only simple, low-risk forms of movement without adding extra exercises or medical disclaimers not provided. Keep the message concise, calm, and practical; focus on one clear activity with plain language. Keep the recommendation practical and easy to integrate into daily routines. NEVER USE EM DASHES, EMOJIS OR ABBREVIATIONS FOR DISEASES IN THE NUDGE. The nudge should be personalized to the following information: ${languageContext} ${genderContext} ${ageContext} ${diseaseContext} ${stageContext} ${educationContext} ${notificationTimeContext} ${activityTypeContext} ${previousNudgesContext} Think carefully before delivering the prompt to ensure it is personalized to the information given (especially any given disease context) and give recommendations based on research backed motivational methods${varietyClause}.`;

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
              name: "nudge_message",
              schema: {
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
            },
          },
        });

        const parsedContent = JSON.parse(
          response.choices[0].message.content ?? "{}",
        ) as { title?: string; body?: string };

        if (
          typeof parsedContent.title !== "string" ||
          typeof parsedContent.body !== "string"
        ) {
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
        const nudge: PosttrialNudgeMessage = {
          title: parsedContent.title,
          body: parsedContent.body,
          isLLMGenerated: true,
          generatedAt,
          llmPrompt: prompt,
          llmPromptVersion: PROMPT_VERSION,
          llmModel: LLM_MODEL,
          ...(tokenUsage && { llmTokenUsage: tokenUsage }),
        };

        logger.info(
          `Generated post-trial LLM nudge for user ${userId} in ${language} (attempt ${attempt})`,
        );
        return nudge;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          `Attempt ${attempt}/${maxRetries} failed for post-trial LLM nudge generation for user ${userId}: ${String(error)}`,
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    logger.error(
      `All ${maxRetries} attempts failed for post-trial LLM nudge generation for user ${userId}. Final error: ${String(lastError)}`,
    );
    return null;
  }

  async createPosttrialNudgeForUser(
    userId: string,
    nudge: PosttrialNudgeMessage,
    targetUtc: Date,
  ): Promise<void> {
    const nudgeId = randomUUID().toUpperCase();
    await this.firestore
      .collection("users")
      .doc(userId)
      .collection("notificationBacklog")
      .doc(nudgeId)
      .set({
        id: nudgeId,
        title: nudge.title,
        body: nudge.body,
        timestamp: admin.firestore.Timestamp.fromDate(targetUtc),
        category: PosttrialNudgeService.CATEGORY,
        isLLMGenerated: nudge.isLLMGenerated,
        generatedAt: nudge.generatedAt,
        ...(nudge.llmPrompt && { llmPrompt: nudge.llmPrompt }),
        ...(nudge.llmPromptVersion !== undefined && {
          llmPromptVersion: nudge.llmPromptVersion,
        }),
        ...(nudge.llmTokenUsage && { llmTokenUsage: nudge.llmTokenUsage }),
        ...(nudge.llmModel && { llmModel: nudge.llmModel }),
      });
  }

  async scheduleWelcomeIfNeeded(
    userId: string,
    userData: PosttrialUserData,
    firstNudgeTargetUtc: Date,
    language: string,
  ): Promise<boolean> {
    if (userData.posttrialWelcomeNudgeScheduled === true) {
      return false;
    }
    if (userData.didOptInToTrial !== true) {
      logger.info(
        `Skipping post-trial welcome nudge for user ${userId}: did not opt into trial`,
      );
      return false;
    }

    const isSpanish = language === "es";
    const welcomeTitle =
      isSpanish ?
        PosttrialNudgeService.WELCOME_TITLE_ES
      : PosttrialNudgeService.WELCOME_TITLE;
    const welcomeBody =
      isSpanish ?
        PosttrialNudgeService.WELCOME_BODY_ES
      : PosttrialNudgeService.WELCOME_BODY;

    const welcomeTime = new Date(
      firstNudgeTargetUtc.getTime() - PosttrialNudgeService.WELCOME_LEAD_MS,
    );
    const welcomeId = randomUUID().toUpperCase();
    const userRef = this.firestore.collection("users").doc(userId);
    const welcomeRef = userRef.collection("notificationBacklog").doc(welcomeId);

    const batch = this.firestore.batch();
    batch.set(welcomeRef, {
      id: welcomeId,
      title: welcomeTitle,
      body: welcomeBody,
      timestamp: admin.firestore.Timestamp.fromDate(welcomeTime),
      category: PosttrialNudgeService.WELCOME_CATEGORY,
      isLLMGenerated: false,
      generatedAt: admin.firestore.Timestamp.now(),
    });
    batch.update(userRef, { posttrialWelcomeNudgeScheduled: true });
    await batch.commit();

    logger.info(
      `Scheduled post-trial welcome nudge for user ${userId} at ${welcomeTime.toISOString()} (1 h before first post-trial nudge at ${firstNudgeTargetUtc.toISOString()})`,
    );
    return true;
  }

  private getUserLanguage(userData: PosttrialUserData): string {
    return userData.userLanguage === "es" ? "es" : "en";
  }

  async createPosttrialNudgeNotifications(): Promise<void> {
    const usersSnapshot = await this.firestore
      .collection("users")
      .where("extendedActivityNudgesOptIn", "==", true)
      .get();

    let usersProcessed = 0;
    let nudgesCreated = 0;
    let welcomesScheduled = 0;
    let usersSkippedDedup = 0;
    let usersSkippedFailure = 0;

    for (const userDoc of usersSnapshot.docs) {
      try {
        const userData = userDoc.data() as PosttrialUserData;
        const userId = userDoc.id;
        usersProcessed++;

        if (userData.mostRecentOnboardingStep !== "finalStep") {
          logger.info(
            `Skipping post-trial nudge for user ${userId}: onboarding not completed (mostRecentOnboardingStep: ${userData.mostRecentOnboardingStep ?? "undefined"}).`,
          );
          continue;
        }

        if (userData.disabled === true) {
          logger.info(
            `Skipping post-trial nudge for user ${userId} - account disabled`,
          );
          continue;
        }

        if (userData.hasWithdrawnFromStudy === true) {
          continue;
        }

        if (userData.didOptInToTrial !== true) {
          logger.info(
            `Skipping post-trial nudge for user ${userId}: did not opt into trial`,
          );
          continue;
        }

        if (!userData.timeZone || !userData.dateOfEnrollment) {
          logger.info(
            `Skipping post-trial nudge for user ${userId}: missing timeZone or dateOfEnrollment`,
          );
          continue;
        }

        const daysSinceEnrollment = this.getDaysSinceEnrollment(
          userData.dateOfEnrollment,
        );
        if (daysSinceEnrollment < PosttrialNudgeService.TRIAL_COMPLETION_DAYS) {
          logger.info(
            `Skipping post-trial nudge for user ${userId}: trial nudges not yet complete (${daysSinceEnrollment} days since enrollment, need ${PosttrialNudgeService.TRIAL_COMPLETION_DAYS})`,
          );
          continue;
        }

        if (!this.isWithinActiveWindow(userData.lastActiveDate)) {
          logger.info(
            `Skipping post-trial nudge for user ${userId}: not active within the last ${PosttrialNudgeService.ACTIVE_WINDOW_DAYS} days`,
          );
          continue;
        }

        const rawNotificationTime = userData.preferredNotificationTime?.trim();
        const preferredTime =
          rawNotificationTime !== undefined && rawNotificationTime !== "" ?
            rawNotificationTime
          : PosttrialNudgeService.DEFAULT_NOTIFICATION_TIME;
        if (preferredTime !== rawNotificationTime) {
          logger.warn(
            `User ${userId} has no preferred notification time for post-trial nudge. Assuming ${PosttrialNudgeService.DEFAULT_NOTIFICATION_TIME} as default.`,
          );
          userData.preferredNotificationTime = preferredTime;
        }

        const targetUtc = this.computeTargetUtc(
          userData.timeZone,
          preferredTime,
        );

        const duplicate = await this.hasNudgeForLocalDay(
          userId,
          targetUtc,
          userData.timeZone,
        );
        if (duplicate) {
          logger.info(
            `Skipping post-trial nudge for user ${userId}: already queued for ${targetUtc.toISOString()}`,
          );
          usersSkippedDedup++;
          continue;
        }

        const userLanguage = this.getUserLanguage(userData);
        const nudge = await this.generateLLMNudge(
          userId,
          userLanguage,
          userData,
          targetUtc,
        );

        if (!nudge) {
          logger.warn(
            `Skipping post-trial nudge for user ${userId}: LLM nudge generation returned no nudge.`,
          );
          usersSkippedFailure++;
          continue;
        }

        await this.createPosttrialNudgeForUser(userId, nudge, targetUtc);
        nudgesCreated++;
        logger.info(
          `Created post-trial nudge for user ${userId} at ${targetUtc.toISOString()} (${userLanguage})`,
        );

        try {
          const welcomed = await this.scheduleWelcomeIfNeeded(
            userId,
            userData,
            targetUtc,
            userLanguage,
          );
          if (welcomed) welcomesScheduled++;
        } catch (welcomeError) {
          // Non-fatal: the post-trial nudge itself was already queued, and
          // the unset flag means the next daily run will retry the welcome.
          logger.error(
            `Failed to schedule post-trial welcome nudge for user ${userId}: ${String(welcomeError)}`,
          );
        }
      } catch (error) {
        logger.error(
          `Error creating post-trial nudge for user ${userDoc.id}: ${String(error)}`,
        );
      }
    }

    logger.info(
      `Post-trial nudge creation complete: ${nudgesCreated} nudges created, ${welcomesScheduled} welcome nudges scheduled, ${usersProcessed} users processed, ${usersSkippedDedup} skipped (dedup), ${usersSkippedFailure} skipped (LLM failure)`,
    );
  }
}

let posttrialNudgeService: PosttrialNudgeService | undefined;

const getPosttrialNudgeService = (): PosttrialNudgeService => {
  posttrialNudgeService ??= new PosttrialNudgeService();
  return posttrialNudgeService;
};

export const createPosttrialNudgeNotifications = () =>
  getPosttrialNudgeService().createPosttrialNudgeNotifications();

export const onScheduleDailyPosttrialNudgeCreation = onSchedule(
  {
    schedule: "30 8 * * *",
    timeZone: "UTC",
    timeoutSeconds: 1800,
    secrets: llmSecretParams,
    serviceAccount: privilegedServiceAccount,
  },
  async () => {
    logger.info("Starting daily post-trial nudge notification creation");

    try {
      await getPosttrialNudgeService().createPosttrialNudgeNotifications();
      logger.info("Daily post-trial nudge notification creation complete");
    } catch (error) {
      logger.error(
        `Error in daily post-trial nudge creation: ${String(error)}`,
      );
    }
  },
);
