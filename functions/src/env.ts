// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { defineSecret, defineString } from "firebase-functions/params";

enum SecretKey {
  OPENAI_API_KEY = "OPENAI_API_KEY",
  OURA_CLIENT_ID = "OURA_CLIENT_ID",
  OURA_CLIENT_SECRET = "OURA_CLIENT_SECRET",
  OURA_WEBHOOK_VERIFICATION_TOKEN = "OURA_WEBHOOK_VERIFICATION_TOKEN",
  FITBIT_CLIENT_ID = "FITBIT_CLIENT_ID",
  FITBIT_CLIENT_SECRET = "FITBIT_CLIENT_SECRET",
  FITBIT_SUBSCRIBER_VERIFICATION_CODE = "FITBIT_SUBSCRIBER_VERIFICATION_CODE",
  WITHINGS_CLIENT_ID = "WITHINGS_CLIENT_ID",
  WITHINGS_CLIENT_SECRET = "WITHINGS_CLIENT_SECRET",
}

// OpenAI --------------------------------------------------------------------

const openaiApiKey = defineSecret(SecretKey.OPENAI_API_KEY);

export const getOpenaiApiKey = (): string => openaiApiKey.value();

export const getOpenaiSecretKeys = (): string[] => [SecretKey.OPENAI_API_KEY];

export const openaiApiKeyParam: ReturnType<typeof defineSecret> = openaiApiKey;

// Health providers ----------------------------------------------------------
//
// Client IDs, client secrets and webhook verification tokens are all Secret
// Manager secrets (keeping every provider credential in one place is simpler and
// harmless even though client IDs are not strictly confidential). They are set
// per Firebase project (dev / staging / prod-US / prod-UK). The public base URL
// is this deployment's function origin (used to build the OAuth callback and
// webhook URLs); the app redirect URL is the deep link the callback bounces back
// to after a successful connection — neither is a credential, so both stay as
// plain string params.

const ouraClientId = defineSecret(SecretKey.OURA_CLIENT_ID);
const ouraClientSecret = defineSecret(SecretKey.OURA_CLIENT_SECRET);
const ouraWebhookVerificationToken = defineSecret(
  SecretKey.OURA_WEBHOOK_VERIFICATION_TOKEN,
);

const fitbitClientId = defineSecret(SecretKey.FITBIT_CLIENT_ID);
const fitbitClientSecret = defineSecret(SecretKey.FITBIT_CLIENT_SECRET);
const fitbitSubscriberVerificationCode = defineSecret(
  SecretKey.FITBIT_SUBSCRIBER_VERIFICATION_CODE,
);

const withingsClientId = defineSecret(SecretKey.WITHINGS_CLIENT_ID);
const withingsClientSecret = defineSecret(SecretKey.WITHINGS_CLIENT_SECRET);

const healthProviderBaseUrl = defineString("HEALTH_PROVIDER_BASE_URL", {
  default: "",
});
const healthProviderAppRedirectUrl = defineString(
  "HEALTH_PROVIDER_APP_REDIRECT_URL",
  { default: "myheartcounts://health-providers" },
);

export const getOuraClientId = (): string => ouraClientId.value();
export const getOuraClientSecret = (): string => ouraClientSecret.value();
export const getOuraWebhookVerificationToken = (): string =>
  ouraWebhookVerificationToken.value();

export const getFitbitClientId = (): string => fitbitClientId.value();
export const getFitbitClientSecret = (): string => fitbitClientSecret.value();
export const getFitbitSubscriberVerificationCode = (): string =>
  fitbitSubscriberVerificationCode.value();

export const getWithingsClientId = (): string => withingsClientId.value();
export const getWithingsClientSecret = (): string =>
  withingsClientSecret.value();

export const getHealthProviderBaseUrl = (): string =>
  healthProviderBaseUrl.value();
export const getHealthProviderAppRedirectUrl = (): string =>
  healthProviderAppRedirectUrl.value();

/**
 * Secret params that any health-provider Cloud Function must declare in its
 * `secrets:` option so the values resolve at runtime.
 */
export const healthProviderSecretParams: Array<
  ReturnType<typeof defineSecret>
> = [
  ouraClientId,
  ouraClientSecret,
  ouraWebhookVerificationToken,
  fitbitClientId,
  fitbitClientSecret,
  fitbitSubscriberVerificationCode,
  withingsClientId,
  withingsClientSecret,
];
