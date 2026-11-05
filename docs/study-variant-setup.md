<!--

This source file is part of the My Heart Counts Firebase open-source project

SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)

SPDX-License-Identifier: MIT

-->

# Setting Up a New Study Variant

A study variant (e.g. `stanford`, `imperial`) is one study with its own Firebase project, deployment and study bundle. All variants share one iOS binary.

Variants are not regions. A second US study with a physically separate backend is a new variant. The region is only an eligibility rule inside a variant's study definition.

Some places are still keyed by region today (plist keys, CI var names, a single shared bundle). They are marked **region-keyed today** below.

Current status for the backend (subject to change):
`stanford` (US) is live. `imperial` (UK) currently runs on the `stanford` backend. Its own CI jobs exist but stay off until its project is configured.

`<VARIANT>` below stands for the variant name, e.g. `IMPERIAL`.

## Order

1. Create the Firebase project
2. Create service accounts and secrets
3. Fix the functions listed below, then deploy the backend
4. Publish the variant's study bundle
5. Add the variant to the iOS app and release

## 1. Firebase Project

- Blaze plan.
- Firestore `(default)` database, Native mode, in the location where the variant's participant data must live (e.g. `europe-west2` for `imperial`). This cannot be changed later.
- Default Storage bucket in the same location. New projects get `<project>.firebasestorage.app`, not `<project>.appspot.com`.
- Authentication: upgrade to Identity Platform (needed for the `beforeUserCreated` and `beforeUserSignedIn` blocking functions). Enable the same sign-in providers as `stanford`.
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

These roles are derived from the code. Before go-live, compare them against `stanford` production with `gcloud projects get-iam-policy <stanford-project-id>`.

## 3. Secrets

Create these in Secret Manager before the first deploy. Deploy fails if one is missing. See [`env.ts`](../functions/src/env.ts).

- `LLM_API_KEY`, `LLM_API_BASE_URL`: OpenAI-compatible endpoint for nudges. Prompts include age, gender, conditions and education, so check the provider's data residency for the variant.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `FEEDBACK_SENDER_EMAIL`, `FEEDBACK_COORDINATOR_EMAIL`: feedback mails, usually sent to the variant's study team.

## 4. Functions

- **`processUserDeletions`** ([`processUserDeletions.ts:23`](../functions/src/functions/processUserDeletions.ts#L23)): the bucket is hardcoded as `<project>.appspot.com`. On a new project, every account deletion fails. Switch to the default bucket before launch.
- **`getStudyDefinition`** ([`index.ts:25`](../functions/src/index.ts#L25)): redirects to a fixed `stanford` bucket. The app does not use it. We should make this more flexible (todo for me, @paulgoldschmidt)
- **Functions region**: none is set, so everything deploys to `us-central1`, and the app calls `us-central1`. If the variant's data must stay in-country, set a region with `setGlobalOptions` and pass the same region to `Functions.functions(region:)` in iOS (@lukas kollmer).
- **Nudges** ([`planNudges.ts`](../functions/src/functions/planNudges.ts), [`planPosttrialNudges.ts`](../functions/src/functions/planPosttrialNudges.ts)): only `en` and `es` (Latin American Spanish) are supported. A new language needs predefined nudges and prompt text. The hardcoded model names must also exist at the variant's LLM endpoint.
- **`onArchivedLiveHealthSampleUploaded`, `processPendingHealthSampleDeletions`**: disabled in [`index.ts`](../functions/src/index.ts). If you re-enable them, the Storage trigger needs `roles/pubsub.publisher` for the Cloud Storage service agent.

## 5. CI/CD

The backend and study definitions repos use the GitHub environment `production` with one pair per variant:

- var `FIREBASE_PROJECT_ID_PRODUCTION_<VARIANT>`
- secret `GOOGLE_APPLICATION_CREDENTIALS_BASE64_PRODUCTION_<VARIANT>` (base64 of the deployer JSON key)

**Region-keyed today:** the existing pairs are `_US` (`stanford`) and `_UK` (`imperial`). Name new ones after the variant.

## Repo Specifics

### MyHeartCounts-Firebase (poc @Paul Goldschmidt)

- [`deployment.yml`](../.github/workflows/deployment.yml): expose the var in the `vars` job, then add a `deployfirebase-production-<variant>` job modeled on the UK job. Production deploys `stanford` first, then the other variants.
- `imperial` needs no workflow change. Its job starts running once `FIREBASE_PROJECT_ID_PRODUCTION_UK` is set to something other than `TODO`.
- A GitHub release triggers the production deploy via [`update-versions-on-release.yml`](../.github/workflows/update-versions-on-release.yml).

### MyHeartCounts-studydefinitions (poc @Paul Goldschmidt)

- One study bundle per variant, published only to that variant's project. **Region-keyed today:** there is one bundle for all variants, and `Sources/MHCStudyDefinitionExporter/Study.swift` gates eligibility by region in `participationCriterion`.
- Each variant's bundle carries its own definition (eligibility, `studyRevision`), consent and content. Because consent comes from the variant's bundle, the phone's region no longer decides which consent applies. Today only `en-US` and `es-US` consent exist.
- `.github/workflows/publish-study-definition.yml`: add the variant's var and secret, then copy the three US steps (auth, upload, verify) in `authenticate-and-publish-production`. The UK steps already exist but are disabled with `if: ${{ false }}`.
- The bundle is uploaded to `gs://<project>.firebasestorage.app/public/mhcStudyBundle.studybundle.tar.zst`. The upload runs `gsutil acl ch`, which fails on buckets with uniform bucket-level access.

### MyHeartCounts-iOS (poc @Lukas Kollmer)

- `SharedContext/StudyVariant.swift`: add a case. It defines the variant's region (used for locale) and news path. Website and privacy URLs live in `MyHeartCounts+Website.swift`.
- `MyHeartCounts/Supporting Files/GoogleService-Info.plist`: one entry per project. The committed file is obv a placeholder. Add an entry with the new project's config, making sure `STORAGE_BUCKET` is `<project>.firebasestorage.app`. Then update the `GOOGLE_SERVICE_INFO_PLIST_BASE64` secret in each GitHub environment. **Region-keyed today:** the keys are `US` and `UK`.
- `Modules/DeferredConfigLoading.swift`: map the variant to its plist entry in `_firebaseOptions(for:)`. **Region-keyed today:** it maps a region via `FirebaseConfigSelector.region`.
- `Onboarding/EligibilityScreening.swift`: decide which variant a participant enrolls in. **Region-keyed today:** it uses `enabledRegions` and `comingSoonRegions`, and `imperial` loads with `backendRegion: .unitedStates`.
- `Modules/ConsentManager.swift` (`defaultLanguageFallbackLocale`) and `Account/Demographics/`: add the variant.
- `Modules/FirebaseFunctions.swift`: change this only if the functions region changes.
- App Store Connect: make the app available in every country the variant enrolls from.
