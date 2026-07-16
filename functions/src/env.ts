// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { defineSecret } from "firebase-functions/params";

enum SecretKey {
  OPENAI_API_KEY = "OPENAI_API_KEY",
  SMTP_USERNAME = "SMTP_USERNAME",
  SMTP_PASSWORD = "SMTP_PASSWORD",
}

const openaiApiKey = defineSecret(SecretKey.OPENAI_API_KEY);

export const getOpenaiApiKey = (): string => openaiApiKey.value();

export const getOpenaiSecretKeys = (): string[] => [SecretKey.OPENAI_API_KEY];

export const openaiApiKeyParam: ReturnType<typeof defineSecret> = openaiApiKey;

const smtpUsername = defineSecret(SecretKey.SMTP_USERNAME);
const smtpPassword = defineSecret(SecretKey.SMTP_PASSWORD);

export const getSmtpUsername = (): string => smtpUsername.value();

export const getSmtpPassword = (): string => smtpPassword.value();

export const smtpUsernameParam: ReturnType<typeof defineSecret> = smtpUsername;

export const smtpPasswordParam: ReturnType<typeof defineSecret> = smtpPassword;
