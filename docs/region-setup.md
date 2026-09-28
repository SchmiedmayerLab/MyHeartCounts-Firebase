<!--

This source file is part of the My Heart Counts Firebase open-source project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)

SPDX-License-Identifier: MIT

-->

# Setting Up a New Region

Each region is its own Firebase project. All regions share one iOS binary and one study bundle. The app picks the project from the region the participant selects during onboarding.

Current status for the backend (subject to change):
US is live. UK is partly wired; its CI jobs exist but stay off until the UK project is configured.

`XX` below stands for the region code, e.g. `UK`.

## Order

1. Create the Firebase project
2. Create service accounts and secrets
3. Fix the functions listed below, then deploy the backend
4. Publish the study bundle
5. Add the region to the iOS app and release

## 1. Firebase Project

- Blaze plan.
- Firestore `(default)` database, Native mode, in-country location (e.g. `europe-west2` for UK). This cannot be changed later.
- Default Storage bucket in the same location. New projects get `<project>.firebasestorage.app`, not `<project>.appspot.com`.
- Authentication: upgrade to Identity Platform (needed for the `beforeUserCreated` and `beforeUserSignedIn` blocking functions). Enable the same sign-in providers as US.
- Register the iOS app with bundle ID `edu.stanford.MyHeartCounts`.
- Cloud Messaging: upload the APNs auth key. Without it, nudges are never delivered.
- APIs: Cloud Functions, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Pub/Sub, Cloud Scheduler, Secret Manager. The first `firebase deploy` enables them if the deployer is allowed to.

## 2. Service Accounts

The two runtime accounts are hardcoded in [`helpers.ts`](../functions/src/functions/helpers.ts). Create them before the first deploy.

**`cloudfunctionsserviceaccount@<project>.iam.gserviceaccount.com`**: scheduled jobs, Firestore triggers, deletions, nudges, feedback mail.

- `roles/datastore.user`
- `roles/storage.objectAdmin`
- `roles/firebaseauth.admin`
- `roles/firebasecloudmessaging.admin`
- `roles/secretmanager.secretAccessor`
- `roles/eventarc.eventReceiver`
- `roles/run.invoker`

**`limited-cloudfunction-sa@<project>.iam.gserviceaccount.com`**: callables, auth blocking functions, `getStudyDefinition`.

- `roles/datastore.user`
- `roles/firebaseauth.admin` (`updateUserInformation` edits the Auth profile)

**CI deployer** (any name, JSON key stored in GitHub): used by `firebase deploy` and by the study bundle upload.

- `roles/firebase.admin`
- `roles/cloudfunctions.admin`
- `roles/run.admin`
- `roles/cloudscheduler.admin`
- `roles/secretmanager.admin` (deploy grants the functions access to their secrets)
- `roles/storage.objectAdmin`
- `roles/iam.serviceAccountUser` on both runtime accounts

These roles are derived from the code. Before go-live, compare them against US production with `gcloud projects get-iam-policy <us-project-id>`.

## 3. Secrets

Create these in Secret Manager before the first deploy. Deploy fails if one is missing. See [`env.ts`](../functions/src/env.ts).

- `LLM_API_KEY`, `LLM_API_BASE_URL`: OpenAI-compatible endpoint for nudges. Prompts include age, gender, conditions and education, so check the provider's data residency for the region.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `FEEDBACK_SENDER_EMAIL`, `FEEDBACK_COORDINATOR_EMAIL`: feedback mails, usually sent to the local study team.

## 4. Functions

- **`processUserDeletions`** ([`processUserDeletions.ts:23`](../functions/src/functions/processUserDeletions.ts#L23)): the bucket is hardcoded as `<project>.appspot.com`. On a new project, every account deletion fails. Switch to the default bucket before launch.
- **`getStudyDefinition`** ([`index.ts:25`](../functions/src/index.ts#L25)): redirects to a fixed US bucket. The app does not use it. We should make this more flexible (todo for me, @paulgoldschmidt)
- **Functions region**: none is set, so everything deploys to `us-central1`, and the app calls `us-central1`. If data must stay in-country, set a region with `setGlobalOptions` and pass the same region to `Functions.functions(region:)` in iOS (@lukas kollmer).
- **Nudges** ([`planNudges.ts`](../functions/src/functions/planNudges.ts), [`planPosttrialNudges.ts`](../functions/src/functions/planPosttrialNudges.ts)): only `en` and `es` (Latin American Spanish) are supported. A new language needs predefined nudges and prompt text. The hardcoded model names must also exist at the region's LLM endpoint.
- **`onArchivedLiveHealthSampleUploaded`, `processPendingHealthSampleDeletions`**: disabled in [`index.ts`](../functions/src/index.ts). If you re-enable them, the Storage trigger needs `roles/pubsub.publisher` for the Cloud Storage service agent.

## 5. CI/CD

The backend and study definitions repos use the GitHub environment `production` with one pair per region:

- var `FIREBASE_PROJECT_ID_PRODUCTION_XX`
- secret `GOOGLE_APPLICATION_CREDENTIALS_BASE64_PRODUCTION_XX` (base64 of the deployer JSON key)

## Repo Specifics

### MyHeartCounts-Firebase (poc @Paul Goldschmidt)

- [`deployment.yml`](../.github/workflows/deployment.yml): expose the var in the `vars` job, then add a `deployfirebase-production-xx` job modeled on the UK job. Production deploys US first, then the other regions.
- UK needs no workflow change. Its job starts running once `FIREBASE_PROJECT_ID_PRODUCTION_UK` is set to something other than `TODO`.
- A GitHub release triggers the production deploy via [`update-versions-on-release.yml`](../.github/workflows/update-versions-on-release.yml).

### MyHeartCounts-studydefinitions (poc @Paul Goldschmidt)

- `.github/workflows/publish-study-definition.yml`: add the same var and secret, then copy the three US steps (auth, upload, verify) in `authenticate-and-publish-production`. The UK steps already exist but are disabled with `if: ${{ false }}`.
- The bundle is uploaded to `gs://<project>.firebasestorage.app/public/mhcStudyBundle.studybundle.tar.zst`. The upload runs `gsutil acl ch`, which fails on buckets with uniform bucket-level access.
- `Sources/MHCStudyDefinitionExporter/Study.swift`: add the region to `participationCriterion` and bump `studyRevision`.
- Consent and localized content only exist for `en-US` and `es-US`. Add files for the region using the `+<lang>-<REGION>` suffix, e.g. `Consent+en-GB.md`.

### MyHeartCounts-iOS (poc @Lukas Kollmer)

- `MyHeartCounts/Supporting Files/GoogleService-Info.plist` has one entry per region (`US`, `UK`). The committed file is obv a placeholder. Add an `XX` entry with the new project's config, making sure `STORAGE_BUCKET` is `<project>.firebasestorage.app`. Then update the `GOOGLE_SERVICE_INFO_PLIST_BASE64` secret in each GitHub environment.
- `Modules/DeferredConfigLoading.swift`: map the region to the new plist key in `_firebaseOptions(for:)`.
- `Onboarding/EligibilityScreening.swift`: add the region to `enabledRegions`. UK is currently listed in `comingSoonRegions` and runs on the US backend as study variant `imperial`.
- `SharedContext/StudyVariant.swift`, `MyHeartCounts+Website.swift`: add a new variant if the region has its own news path, website or privacy URL.
- `Modules/ConsentManager.swift` (`defaultLanguageFallbackLocale`) and `Account/Demographics/`: add the region.
- `Modules/FirebaseFunctions.swift`: change this only if the functions region changes.
- App Store Connect: make the app available in the new country.
