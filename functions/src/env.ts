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
  GOOGLE_HEALTH_CLIENT_ID = "GOOGLE_HEALTH_CLIENT_ID",
  GOOGLE_HEALTH_CLIENT_SECRET = "GOOGLE_HEALTH_CLIENT_SECRET",
  WITHINGS_CLIENT_ID = "WITHINGS_CLIENT_ID",
  WITHINGS_CLIENT_SECRET = "WITHINGS_CLIENT_SECRET",
  HEALTH_PROVIDER_IDENTITY_KEY = "HEALTH_PROVIDER_IDENTITY_KEY",
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

// A Google Cloud OAuth 2.0 client's id/secret for the Google Health API
// (see GoogleHealthAdapter), the replacement for the legacy Fitbit Web API.
const googleHealthClientId = defineSecret(SecretKey.GOOGLE_HEALTH_CLIENT_ID);
const googleHealthClientSecret = defineSecret(
  SecretKey.GOOGLE_HEALTH_CLIENT_SECRET,
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

export const getGoogleHealthClientId = (): string =>
  googleHealthClientId.value();
export const getGoogleHealthClientSecret = (): string =>
  googleHealthClientSecret.value();

export const getWithingsClientId = (): string => withingsClientId.value();
export const getWithingsClientSecret = (): string =>
  withingsClientSecret.value();

// Grove FHIR identity key: the ≥32-byte HMAC-SHA-256 key behind every opaque
// Grove identifier (source record/output/artifact, device snapshot, record
// version) in the provider exchange Bundles. Stored hex- or base64-encoded.
// The key id and epoch name it in every identifier system
// (`…/NamingSystem/grove-<kind>-v0/<keyId>/<epoch>`); rotating the key means a
// new key id or epoch, and old keys must be kept while their identifiers can
// still be replayed or retracted.
const healthProviderIdentityKey = defineSecret(
  SecretKey.HEALTH_PROVIDER_IDENTITY_KEY,
);
const healthProviderIdentityKeyId = defineString(
  "HEALTH_PROVIDER_IDENTITY_KEY_ID",
  { default: "mhcbackend1" },
);
const healthProviderIdentityEpoch = defineString(
  "HEALTH_PROVIDER_IDENTITY_EPOCH",
  { default: "1" },
);

export const getHealthProviderIdentityKey = (): string =>
  healthProviderIdentityKey.value();
export const getHealthProviderIdentityKeyId = (): string =>
  healthProviderIdentityKeyId.value();
export const getHealthProviderIdentityEpoch = (): string =>
  healthProviderIdentityEpoch.value();

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
  googleHealthClientId,
  googleHealthClientSecret,
  withingsClientId,
  withingsClientSecret,
  healthProviderIdentityKey,
];
