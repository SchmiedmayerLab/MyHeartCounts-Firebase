<!--
This source file is part of the My Heart Counts project

SPDX-FileCopyrightText: 2025, 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
SPDX-License-Identifier: MIT
-->
[![Build and Test](https://github.com/StanfordBDHG/MyHeartCounts-Firebase/actions/workflows/build-and-test.yml/badge.svg?branch=main)](https://github.com/StanfordBDHG/MyHeartCounts-Firebase/actions/workflows/build-and-test.yml)
[![CodeQL](https://github.com/StanfordBDHG/MyHeartCounts-Firebase/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/StanfordBDHG/MyHeartCounts-Firebase/actions/workflows/codeql.yml)
[![Deployment](https://github.com/StanfordBDHG/MyHeartCounts-Firebase/actions/workflows/deployment.yml/badge.svg?branch=main)](https://github.com/StanfordBDHG/MyHeartCounts-Firebase/actions/workflows/deployment.yml)

# My Heart Counts

Firebase cloud hosting infrastructure for the Stanford My Heart Counts project.

The iOS Application can be found in the [StanfordBDHG/MyHeartCounts-iOS](https://github.com/StanfordBDHG/MyHeartCounts-iOS) repository, the repository for the data analysis side of this study can be found over at [StanfordBDHG/MyHeartCounts-DataAnalysis](https://github.com/StanfordBDHG/MyHeartCounts-DataAnalysis).

The study itself with its contents is defined in [StanfordBDHG/MyHeartCounts-StudyDefinitions](https://github.com/StanfordBDHG/MyHeartCounts-StudyDefinitions).

Key features of the backend infrastructure include:
- User account setup using blocking functions
- Decoding of archived sensor- and healthdata
- Questinaire parsing
- User State Handeling
- Physical Activity Trial with personalized coaching messages using a Large Language Model (LLM) to generate personalized physical activity nudges in a blind study approach to compare predefined nudges and LLM nudges
- Region-based waitlist for anonymous users (no account required) using ISO 3166-1 alpha-2 country codes

> [!NOTE]
> Do you want to learn more about the Stanford Spezi Template Application and how to use, extend, and modify this application? Check out the [Stanford Spezi Template Application documentation](https://stanfordspezi.github.io/SpeziTemplateApplication).


## Data Structure

My Heart Counts Firebase makes extensive usage of both the Firestore Database (NoSQL cloud database) and Firebase Cloud Storage (object storage service). 

### Variables in the Data Structure

|Variable|Origin|Example|
|-|-|-|
|`{USER-ID}`|The Firebase-Generated Account User-ID|`vqzvMTfki9hD0yqTcVVW8XsKf6g2`|
|`{UUID}`|Randomly generated Sample ID|`BCD7D622-0CDC-4194-A008-3452C9C95546`|
|`{HEALTHKIT.IDENTIFIER}`|HealthKit Identifier / [HKQuantityTypeIdentifier](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier)|`HKClinicalTypeIdentifierAllergyRecord`|
|`{SENSORKIT.IDENTIFIER}`|[Sensor identifier name](https://developer.apple.com/documentation/sensorkit/) from the SensorKit Framework|`com.apple.SensorKit.ambientPressure`|
|`{MHCCUSTOM.IDENTIFIER}`|Custom Sample Type defined for the My Heart Counts Study|`MHCHealthObservationTimedWalkingTestResultIdentifier`|
|`{TIMESTAMP}`|ISO 8601 Timestamp, delimited by an underscore (_) for time ranges|`2025-11-17T22:44:09Z_2025-11-17T23:44:09Z`|

### Firestore Database

|Path|Purpose|Fields|
|-|-|-|
|`/feedback/{UUID}`|Collection for Participant-Submitted Feedback|`accountId`, `appBuildNumber`, `appVersion`, `date`, `deviceInfo` (`model`, `osVersion`, `systemName`), `message`, `timeZone` (`identifier`)|
|`/waitlist/{REGION}_{EMAIL}`|Region-based waitlist entries for anonymous users|`region` (ISO 3166-1 alpha-2), `email`, `createdAt`|
|`/users/{USER-ID}`|User Document|See [User Document Fields](#user-document-fields) below|
|`/users/{USER-ID}/questionnaireResponses/{UUID}`|FHIR questionnaire responses|See [FHIR questionnaireresponse documentation](https://build.fhir.org/questionnaireresponse.html)|
|`/users/{USER-ID}/notificationBacklog/{UUID}`|Backlog of Notifications to send|`body`, `category`, `generatedAt`, `id`, `isLLMGenerated`, `timestamp`, `title`|
|`/users/{USER-ID}/notificationHistory/{UUID}`|History of send notifications|`body`, `errorMessage`, `generatedAt`, `isLLMGenerated`, `originalTimestamp`, `processedTimestamp`, `status`, `title`|
|`/users/{USER-ID}/notificationTracking/{UUID}`|Tracks the Notification Status|`event`, `notificationId`, `timeZone`, `timestamp`|
|`/users/{USER-ID}/SensorKitObservations_deviceUsageReport/{UUID}`|Debug Info about Sensor Kit Hardware Environment|FHIR Observation for custom MHC sample|See [FHIR observation documentation](https://hl7.org/fhir/R4/observation.html)|
|`/users/{USER-ID}/HealthObservations_{HEALTHKIT.IDENTIFIER}/{UUID}`|FHIR Observation for given health kit type|See [FHIR observation documentation](https://hl7.org/fhir/R4/observation.html)|
|`/users/{USER-ID}/HealthObservations_{SENSORKIT.IDENTIFIER}/{Timestamp}`|FHIR Observation for given sensor kit type|See [FHIR observation documentation](https://hl7.org/fhir/R4/observation.html)|

#### User Document Fields

The following table provides an overview of all fields in the `/users/{USER-ID}` document, their Firestore data types, and whether they are written by the client (iOS app) or the server (Cloud Functions).

|Field|Data Type|Set By|Encoding|Description|
|-|-|-|-|-|
|`biologicalSexAtBirth`|int64|Client|[HKBiologicalSex](https://developer.apple.com/documentation/healthkit/hkbiologicalsex)|Biological sex at birth|
|`bloodType`|int64|Client|[HKBloodType](https://developer.apple.com/documentation/healthkit/hkbloodtype)|Blood type|
|`comorbidities`|map|Client||Map of disease name to year of diagnosis|
|`dateOfBirth`|timestamp|Client||User's date of birth|
|`dateOfEnrollment`|timestamp|Server||Timestamp of when the user enrolled into the study|
|`didOptInToTrial`|boolean|Client||Whether the user opted into the physical activity trial|
|`disabled`|boolean|Client||Whether the user account is disabled|
|`educationUK`|string|Client||UK education level (e.g. `"doctoralDegree"`)|
|`educationUS`|string|Client||US education level (e.g. `"bachelor"`)|
|`fcmToken`|string|Client||Firebase Cloud Messaging token for push notifications|
|`futureStudies`|boolean|Client||Whether the user consented to be contacted for future studies|
|`heightInCM`|double|Client||User's height in centimeters|
|`householdIncomeUK`|int64|Client||UK household income bracket|
|`householdIncomeUS`|int64|Client||US household income bracket|
|`language`|string|Client||User's preferred language (e.g. `"en"`)|
|`lastActiveDate`|timestamp|Client||Timestamp of the user's last app activity|
|`lastUploadDate`|timestamp|Server||Timestamp of the user's last data upload|
|`lastSignedConsentDate`|timestamp|Client||Timestamp of the most recent consent signature|
|`lastSignedConsentVersion`|string|Client||Version string of the most recently signed consent|
|`latinoStatus`|int64|Client||Latino/Hispanic status|
|`mhcGenderIdentity`|int64|Client||Gender identity|
|`mostRecentOnboardingStep`|string|Client||Identifier of the last completed onboarding step|
|`nhsNumber`|string|Client||UK National Health Service number|
|`participantGroup`|int64|Server||Randomly assigned trial group (1 or 2)|
|`preferredMeasurementSystem`|string|Client||User's preferred measurement system (e.g. metric, imperial)|
|`preferredNotificationTime`|string|Client||Preferred time for notifications (e.g. `"09:00"`)|
|`preferredWorkoutTypes`|string|Client||Comma-separated preferred workout types (e.g. `"walk,run"`)|
|`raceEthnicity`|int64|Client||Race/ethnicity|
|`stageOfChange`|string|Client||Transtheoretical model stage of change (e.g. `"a"`)|
|`timeZone`|string|Client||IANA time zone identifier (e.g. `"America/New_York"`)|
|`ukRegion`|string|Client||UK region|
|`usRegion`|string|Client||US state/region code (e.g. `"FL"`)|
|`weightInKG`|double|Client||User's weight in kilograms|

### Firebase Cloud Storage

|Path|Purpose|
|-|-|
|`/public/mhcStudyBundle.spezistudybundle.aar`|This it the Study definition bundle auto-build by the workflow in [MyHeartCounts-StudyDefinitions](https://github.com/StanfordBDHG/MyHeartCounts-StudyDefinitions/blob/main/.github/workflows/publish-study-definition.yml)|
|`/user/{USER-ID}/consent`|PDF Files of every consent the user gave (this could be multiple in the case of consent revisions or re-signup by the user.)|
|`/user/{USER-ID}/historicalHealthSamples/{HEALTHKIT.IDENTIFIER}{UUID}.json.zstd`|We collect health samples that were recorded before the user enrolled into the app, compress them via zstd and store them as-is in the folder historicalHealthSamples for future analytics|
|`/user/{USER-ID}/liveHealthSamples/{UUID}.json.zstd`|Most recorded ongoing (new) health samples get directly uploaded into the Firestore NoSQL Database - however, if a large amount of data has accumulated, we archive these samples for server-side decoding and upload them into liveHealthSamples. **This folder will be empty most of the time!** On Upload, the function [onArchivedLiveHealthSampleUploaded.ts](functions/src/functions/onArchivedLiveHealthSampleUploaded.ts) gets triggered which upon successful unpacking and storing into the Firestore Database deletes the live health sample archive.|
|`/user/{USER-ID}/SensorKit/{SENSORKIT.IDENTIFIER}/{UUID}.csv.zstd`|Samples from Apple's SensorKit Framework, sorted in sub-folders.|

## Development

This section contains developer information to kickstart local- and cloud development using the ressources from this repository.

### Infrastructure Overview

To use Firebase functions for your own project or to emulate them for client applications, this section will help to give an overview of the different packages in use and how to install, build, test and launch them.

This repository contains one additional package:

- The package located in [functions](functions) contains the Firebase functions and services that are called from these functions.

### Project Scripts

To make this structure simpler to use, we provide different scripts as part of the [package.json](package.json) file in the root directory of this repository. The file ensures execution order between the two packages. We only document the scripts located in this file, since they cover the most common use cases, feel free to have a look at the individual package.json files of the respective packages to get a deeper understanding and more package-focused operations.

|Command|Purpose|
|-|-|
|`npm run install`|Installs dependencies (incl. dev dependencies) for both packages.|
|`npm run clean`|Cleans existing build artifacts for both packages.|
|`npm run build`|Builds both packages. If you have added or removed files in one of the packages, make sure to clean before using this command.|
|`npm run lint`|Lints both packages. Make sure to build before using this command. You may want to append `:fix` to fix existing issues automatically or `:strict` to make sure the command does not succeed with existing warnings or errors.|
|`npm run prepare`|Combines cleaning, installing and building both packages.|
|`npm run test:ci`|Tests the Firebase functions with emulators running and with test coverage collection active.|
|`npm run serve:seeded`|Starts up the relevant emulators for My Heart Counts and seeds them. Make sure to build the project first before executing this command.|

For using the emulators for client applications, it is probably easiest to call `npm run prepare` whenever files could have changed (e.g. when changing branch or pulling new changes) and then calling `npm run serve:seeded` to start up the emulators in a seeded state. Both of these commands are performed in the root directory of this repository.

Otherwise, you may want to use Docker to run the emulators.  For this, you can use the following command:

```bash
docker compose up
```

This can be especially useful if you're using an operating system like Windows, as scripts contain OS-specific commands that may not work the same way across different platforms.

### Testing

We aim for 70% test covarage in this project. Please be sure to rebuild the project after making changes by running `npm run prepare` or `npm run build` before executing `npm run test:ci`.

### Labels / Development Naming Conventions

Branches are following a `<type>/<short-description>` naming structure, e.g. `feature/user-authentication` or `chore/update-dependencies`. If there is a ticket/issue number that is associated with the branch, the ticket number is part of the branch name: `<type>/<issue-number>-<short-description>` (e.g. `feature/123-user-authentication` or `hotfix/789-payment-timeout`).

### REUSE Compatibility

All project files must adhere to version 3.3 of the REUSE Specification. A template for the file header is provided as [spezi.jinja2](.reuse/templates/spezi.jinja2), which can be auto-applied with:

```bash
reuse annotate \
  --copyright="Stanford University and the project authors (see CONTRIBUTORS.md)" \
  --license="MIT" \
  --year="$(date +%Y)" \
  --copyright-prefix=spdx \
  --template=spezi \
  --merge-copyrights \
  --recursive \
  --fallback-dot-license \
  .
```

Before submitting a new PR, make sure `reuse lint` does not throw any errors about missing copyright/licensing information.

### Update Firestore Indexes

If while developing the indexes in the remote firebase changed (e.g. App-Side Changes), you can use

```bash
firebase firestore:indexes > firestore.indexes.json
```

to update the local firebase index file.

### Organisation while developing

We are happy for any new features, bug fixes and enhancements in this repo at any time; you can find a selection of issue templates if you just want to notify us of an issue, otherwise open a PR to directly contribute to the source code. Either way, we ask that you mark your development branches and issues to help us stay organized.

#### Prefixes in branches

- `feature/` – new functionality
- `tweak/` – small adjustment, minor polish
- `bug/` – bug fixes
- `chore/` – maintenance tasks
- `hotfix/` – urgent production fixes
- `refactor/` – code restructuring
- `docs/` – documentation only
- `test/` – test additions/test changes
- `release/` – release preparation (e.g. release/4.1.0)

#### Labels in issues

For adding searchable metadata to issues and PRs, we use these custom labels:
- `bug` – something is broken or behaving unexpectedly
- `dependencies` – pull requests that update a dependency file
- `duplicate` – this issue or pull request already exists
- `enhancement` – new feature or request
- `good first issue` – good for newcomers
- `help wanted` – extra attention is needed
- `invalid` – this doesn't seem right
- `javascript` – pull requests that update javascript code
- `wontfix` – this will not be worked on
- `tweak` – small adjustment, minor polish
- `feature` – new functionality request
- `chore` – maintenance, dependencies, tooling
- `docs` – documentation additions or fixes
- `refactor` – code restructuring without behavior change
- `tests` – adding or fixing tests
- `performance` – performance improvements
- `hotfix` – urgent production fix
- `security` – vulnerability or security concern
- `question` – needs clarification or discussion
- `blocked` – waiting on something external
- `spike` – research/investigation task
- `breaking` – introduces a breaking change

### Deployment Overview

For this study, we choose to have three environments to test, stage and then run the code in production:

- **My Heart Counts Development** serves as the internal testing playground for iterating rapidly. Deployed to manually via CLI, not via a pipeline.
- **tds/development** is the staging environment hosted by [Stanford Technology and Digital Solutions of the School of Medicine and Stanford Health Care](https://med.stanford.edu/irt.html). We publish to this environment via [the CI pipeline](.github/workflows/deployment.yml) on push to main and make sure that every setting matches the production environment 1:1 (Service Account Rules, Notification Settings, Tokens, API Keys).
- **tds/production** is the production environment of the My Heart Counts Study in the US. It is also hosted by [Stanford Technology and Digital Solutions of the School of Medicine and Stanford Health Care](https://med.stanford.edu/irt.html). We publish here via [the CI pipeline](.github/workflows/deployment.yml) on release, in sync if needed with the iOS deployment.

### Data Flows

#### Questionaire Processing

```mermaid
flowchart TD
    A[User uploads Questionnaire Response] -->|Firestore write event| B[onUserQuestionnaireResponseWritten]
    B -->|Converts Firestore data| C[TriggerService.questionnaireResponseWritten]
    C -->|Determines if new/updated| D{After document exists?}

    D -->|No| E[End - Document deleted]
    D -->|Yes| F[MultiQuestionnaireResponseService.handle]

    F -->|Iterates through components| G[DietScoringService]
    F -->|Iterates through components| H[NicotineScoringService]
    F -->|Iterates through components| I[HeartRiskNicotineScoringService]
    F -->|Iterates through components| J[HeartRiskLdlParsingService]

    G -->|Checks questionnaire URL| K{Matches Diet questionnaire?}
    K -->|Yes| L[Calculate Diet Score]
    K -->|No| M[Skip - Return false]

    H -->|Checks questionnaire URL| N{Matches Nicotine questionnaire?}
    N -->|Yes| O[Extract smoking status]
    N -->|No| P[Skip - Return false]

    I -->|Checks questionnaire URL| Q{Matches Heart Risk Nicotine?}
    Q -->|Yes| R[Process Heart Risk Nicotine]
    Q -->|No| S[Skip - Return false]

    J -->|Checks questionnaire URL| T{Matches LDL questionnaire?}
    T -->|Yes| U[Parse LDL values]
    T -->|No| V[Skip - Return false]

    L -->|Score calculated| W[Create FHIR Observation]
    O -->|Convert to score 0-4| X[Create FHIR Observation]
    R -->|Process data| Y[Create FHIR Observation]
    U -->|Parse cholesterol data| Z[Create FHIR Observation]

    W -->|Store in Firestore| AA[users/USER-ID/HealthObservations_MHCCustomSampleTypeDietMEPAScore]
    X -->|Store in Firestore| AB[users/USER-ID/HealthObservations_MHCCustomSampleTypeNicotineExposure]
    Y -->|Store in Firestore| AC[users/USER-ID/HealthObservations_MHCCustomSampleTypeHeartRiskNicotine]
    Z -->|Store in Firestore| AD[users/USER-ID/HealthObservations_MHCCustomSampleTypeLDL]

    AA --> AE[Log Success]
    AB --> AE
    AC --> AE
    AD --> AE
    AE --> AF[Return handled status]

    M --> AF
    P --> AF
    S --> AF
    V --> AF

    AF --> AG{Any service handled?}
    AG -->|Yes| AH[Log: Handled questionnaire response]
    AG -->|No| AI[Log: No handler found]

    AH --> AJ[End]
    AI --> AJ
    E --> AJ

    style A fill:#e1f5ff
    style B fill:#fff4e1
    style C fill:#fff4e1
    style F fill:#ffe1f5
    style G fill:#e1ffe1
    style H fill:#e1ffe1
    style I fill:#e1ffe1
    style J fill:#e1ffe1
    style W fill:#f5e1ff
    style X fill:#f5e1ff
    style Y fill:#f5e1ff
    style Z fill:#f5e1ff
    style AA fill:#ffe1e1
    style AB fill:#ffe1e1
    style AC fill:#ffe1e1
    style AD fill:#ffe1e1
    style AJ fill:#d3d3d3
```

#### User Signup Blocking Function

```mermaid
flowchart TD
    A[Firebase Auth Event] -->|beforeUserCreated| B[Extract userId & email]
    B --> C{Email present?}
    C -->|No| D[Throw auth/invalid-email]
    C -->|Yes| E[userService.enrollUserDirectly]
    E --> F[Create user document in Firestore]
    F --> G[Trigger userEnrolled event]
    G --> H[Return custom claims]

    I[Firebase Auth Event] -->|beforeUserSignedIn| J[Extract userId]
    J --> K[userService.getUser]
    K --> L[Retrieve user document]
    L --> M{User found?}
    M -->|Yes| N[Extract custom claims]
    M -->|No| O[Return empty claims]
    N --> P[Return claims & session claims]
    O --> P

    F -->|Store in| Q[users/USER-ID]
    D --> R[End - Signup blocked]
    H --> S[End - User enrolled]
    P --> T[End - Sign-in allowed]

    style A fill:#e1f5ff
    style B fill:#fff4e1
    style E fill:#ffe1f5
    style F fill:#f5e1ff
    style G fill:#ffe1f5
    style Q fill:#ffe1e1
    style I fill:#e1f5ff
    style K fill:#ffe1f5
    style L fill:#f5e1ff
```

#### Generate Nudges Function

```mermaid
flowchart TD
    A[Scheduled: Daily 08:00 UTC] --> B[Fetch all users from Firestore]
    B --> C[Filter users with triggerNudgeGeneration]
    C --> D{User in trial & opted in?}
    D -->|No| E[Skip user]
    D -->|Yes| F[Check participantGroup & days enrolled]

    F --> G{Days since enrollment?}
    G -->|7 days| H[Generate predefined nudges]
    G -->|14 days, Group 1| H
    G -->|14 days, Group 2| I[Call OpenAI GPT-5.2]

    I --> J[Build personalized context]
    J -->|age, diseases, stage, education, language| K[LLM generates 7 nudges]
    K --> L{LLM success?}
    L -->|No, retry 3x| M[Continue retries]
    M --> L
    L -->|Yes| N[Parse LLM response]

    H --> O[Select 7 predefined messages]
    N --> P[Validate message structure]
    O --> Q[Schedule 7 nudges]
    P --> Q

    Q --> R[Write to notificationBacklog]
    R -->|For each nudge| S[users/USER-ID/notificationBacklog/UUID]
    S -->|Fields| T[title, body, timestamp, category, isLLMGenerated, generatedAt]

    T --> U[Reset triggerNudgeGeneration: false]
    U --> V[Log processed count]
    E --> V
    V --> W[End]

    style A fill:#e1f5ff
    style B fill:#fff4e1
    style I fill:#ffe1f5
    style K fill:#ffe1f5
    style H fill:#e1ffe1
    style R fill:#f5e1ff
    style S fill:#ffe1e1
    style W fill:#d3d3d3
```

#### Archived Sample Functions

```mermaid
flowchart TD
    A[File upload event] -->|users/USER-ID/liveHealthSamples/filename| B[Extract userId from path]
    B --> C[Download compressed file]
    C --> D[Decompress with fzstd]
    D --> E[Parse JSON content]

    E --> F{Validate structure}
    F -->|Invalid| G[Log error & delete file]
    F -->|Valid| H[Extract observations array]

    H --> I{Parse filename}
    I -->|SensorKit pattern| J[Map to SensorKitObservations_dataType]
    I -->|HealthKit pattern| K[Map to HealthObservations_identifier]

    J --> L[Batch write 500 docs at a time]
    K --> L
    L -->|Store in| M[users/USER-ID/collection/observationId]

    M --> N[Delete processed file from Storage]
    N --> O[Log observation count]
    G --> O
    O --> P[End]

    style A fill:#e1f5ff
    style C fill:#fff4e1
    style D fill:#fff4e1
    style E fill:#ffe1f5
    style L fill:#f5e1ff
    style M fill:#ffe1e1
    style N fill:#ffe1f5
    style P fill:#d3d3d3
```

#### Send Nudges Function

```mermaid
flowchart TD
    A[Scheduled: Every 15 minutes] --> B[Fetch all users]
    B --> C[For each user: Read notificationBacklog]
    C --> D{Backlog items exist?}
    D -->|No| E[Skip user]
    D -->|Yes| F[Check each item timestamp]

    F --> G{timestamp <= now?}
    G -->|No| H[Keep in backlog]
    G -->|Yes| I[Get user fcmToken]

    I --> J{fcmToken exists?}
    J -->|No| K[Create failed history entry]
    J -->|Yes| L[Send via admin.messaging]

    L --> M{Send successful?}
    M -->|Yes| N[Create sent history entry]
    M -->|No| K

    N -->|Write to| O[users/USER-ID/notificationHistory/UUID]
    K -->|Write to| O
    O -->|Fields| P[title, body, status, processedTimestamp, errorMessage, isLLMGenerated]

    P --> Q[Delete from notificationBacklog]
    Q --> R[Log sent count]
    E --> R
    H --> R
    R --> S[End]

    style A fill:#e1f5ff
    style B fill:#fff4e1
    style C fill:#fff4e1
    style L fill:#ffe1f5
    style N fill:#f5e1ff
    style O fill:#ffe1e1
    style Q fill:#ffe1f5
    style S fill:#d3d3d3
```

#### Delete Account Function

```mermaid
flowchart TD
    A[User calls markAccountForDeletion] --> B{User authenticated?}
    B -->|No| C[Throw unauthenticated error]
    B -->|Yes| D[Extract userId from auth.uid]

    D --> E[userService.getUser]
    E --> F{User document exists?}
    F -->|No| G[Throw not-found error]
    F -->|Yes| H{User already disabled?}

    H -->|Yes| I[Throw failed-precondition error]
    H -->|No| J[Update user document]
    J -->|Set fields| K[toBeDeleted: true, markedForDeletionAt: timestamp]

    K -->|Write to| L[users/USER-ID]
    L --> M[Return success response]
    M -->|Fields| N[success: true, markedAt: ISO timestamp]

    C --> O[End - Error thrown]
    G --> O
    I --> O
    N --> P[End - Account marked]

    style A fill:#e1f5ff
    style D fill:#fff4e1
    style E fill:#ffe1f5
    style J fill:#f5e1ff
    style L fill:#ffe1e1
    style P fill:#d3d3d3
```

#### Bulk Deletion of Samples Function

```mermaid
flowchart TD
    A[User calls deleteHealthSamples] --> B{User authenticated?}
    B -->|No| C[Throw unauthenticated error]
    B -->|Yes| D[Validate input schema]

    D --> E{userId, collection, documentIds present?}
    E -->|No| F[Throw invalid-argument error]
    E -->|Yes| G{documentIds.length <= 50000?}
    G -->|No| F
    G -->|Yes| H{User has permission for userId?}

    H -->|No| I[Throw permission-denied error]
    H -->|Yes| J[Generate jobId]
    J --> K[Return immediate response]
    K -->|Fields| L[status: accepted, jobId, totalSamples, estimatedDurationMinutes]

    L --> M[Start async background processing]
    M --> N[Batch documentIds into groups of 500]
    N --> O[For each batch: Retrieve documents]
    O --> P[Update document status]
    P -->|Set field| Q[status: entered-in-error]

    Q -->|Update in| R[users/USER-ID/collection/documentId]
    R --> S[100ms delay between batches]
    S --> T{More batches?}
    T -->|Yes| O
    T -->|No| U[Log completion & stats]

    C --> V[End - Error thrown]
    F --> V
    I --> V
    U --> W[End - Samples marked]

    style A fill:#e1f5ff
    style D fill:#fff4e1
    style J fill:#ffe1f5
    style M fill:#ffe1f5
    style P fill:#f5e1ff
    style R fill:#ffe1e1
    style W fill:#d3d3d3
```

#### Pending Health Sample Deletion Queue Function

```mermaid
flowchart TD
    A[Scheduled: Every 30 minutes] --> B[Query pendingHealthSampleDeletions]
    B -->|nextRetryAt <= now, limit 500| C{Queue empty?}
    C -->|Yes| D[Log: Nothing to process]
    C -->|No| E[Process items with concurrency limit 10]

    E --> F[For each item: Validate]
    F --> G{Valid item?}
    G -->|No| H[Delete invalid item & skip]
    G -->|Yes| I[Update target document status]

    I -->|Set field| J[status: entered-in-error]
    J -->|Update in| K[users/USER-ID/collection/documentId]

    K --> L{Update successful?}
    L -->|Yes| M[Delete queue item]
    L -->|No| N{retryCount >= 10?}

    N -->|No| O[Increment retryCount]
    O --> P[Calculate exponential backoff]
    P -->|Update| Q[nextRetryAt with backoff, capped at 1h]

    N -->|Yes| R[Move to dead-letter collection]
    R -->|Write to| S[users/USER-ID/failedHealthSampleDeletions]

    M --> T[Log completion stats]
    H --> T
    Q --> T
    S --> T
    D --> T
    T --> U[End]

    style A fill:#e1f5ff
    style B fill:#fff4e1
    style E fill:#fff4e1
    style I fill:#ffe1f5
    style J fill:#f5e1ff
    style K fill:#ffe1e1
    style R fill:#ffe1f5
    style U fill:#d3d3d3
```

### Contributing

Contributions to this project are welcome. Please make sure to read the [contribution guidelines](https://github.com/StanfordBDHG/.github/blob/main/CONTRIBUTING.md) and the [contributor covenant code of conduct](https://github.com/StanfordBDHG/.github/blob/main/CODE_OF_CONDUCT.md) first.


## License

This project is licensed under the MIT License. See [Licenses](https://github.com/StanfordBDHG/MyHeartCounts-iOS/tree/main/LICENSES) for more information.

![Stanford Biodesign Footer](https://raw.githubusercontent.com/StanfordBDHG/.github/main/assets/biodesign-footer-light.png#gh-light-mode-only)
![Stanford Biodesign Footer](https://raw.githubusercontent.com/StanfordBDHG/.github/main/assets/biodesign-footer-dark.png#gh-dark-mode-only)