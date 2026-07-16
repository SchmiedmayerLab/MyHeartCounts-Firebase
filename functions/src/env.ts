// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { defineSecret } from "firebase-functions/params";

enum SecretKey {
  OPENAI_API_KEY = "OPENAI_API_KEY",
  SMTP_HOST = "SMTP_HOST",
  SMTP_PORT = "SMTP_PORT",
  SMTP_USERNAME = "SMTP_USERNAME",
  SMTP_PASSWORD = "SMTP_PASSWORD",
  FEEDBACK_SENDER_EMAIL = "FEEDBACK_SENDER_EMAIL",
  FEEDBACK_COORDINATOR_EMAIL = "FEEDBACK_COORDINATOR_EMAIL",
}

const openaiApiKey = defineSecret(SecretKey.OPENAI_API_KEY);

export const getOpenaiApiKey = (): string => openaiApiKey.value();

export const getOpenaiSecretKeys = (): string[] => [SecretKey.OPENAI_API_KEY];

export const openaiApiKeyParam: ReturnType<typeof defineSecret> = openaiApiKey;

const smtpHost = defineSecret(SecretKey.SMTP_HOST);
const smtpPort = defineSecret(SecretKey.SMTP_PORT);
const smtpUsername = defineSecret(SecretKey.SMTP_USERNAME);
const smtpPassword = defineSecret(SecretKey.SMTP_PASSWORD);
const feedbackSenderEmail = defineSecret(SecretKey.FEEDBACK_SENDER_EMAIL);
const feedbackCoordinatorEmail = defineSecret(
  SecretKey.FEEDBACK_COORDINATOR_EMAIL,
);

export const getSmtpHost = (): string => smtpHost.value();

export const getSmtpPort = (): string => smtpPort.value();

export const getSmtpUsername = (): string => smtpUsername.value();

export const getSmtpPassword = (): string => smtpPassword.value();

export const getFeedbackSenderEmail = (): string => feedbackSenderEmail.value();

export const getFeedbackCoordinatorEmail = (): string =>
  feedbackCoordinatorEmail.value();

export const smtpUsernameParam: ReturnType<typeof defineSecret> = smtpUsername;

export const smtpPasswordParam: ReturnType<typeof defineSecret> = smtpPassword;

export const feedbackEmailSecretParams: Array<ReturnType<typeof defineSecret>> =
  [
    smtpHost,
    smtpPort,
    smtpUsername,
    smtpPassword,
    feedbackSenderEmail,
    feedbackCoordinatorEmail,
  ];
