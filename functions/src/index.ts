// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import admin from "firebase-admin";
import { https } from "firebase-functions/v2";
import { defaultServiceAccount } from "./functions/helpers.js";

// Initialize Firebase with default settings
admin.initializeApp();

// Set Firestore settings to ignore undefined properties
const firestore = admin.firestore();
firestore.settings({
  ignoreUndefinedProperties: true,
});

// Get study definition - this will be available at /getStudyDefinition
export const getStudyDefinition = https.onRequest(
  {
    serviceAccount: defaultServiceAccount,
  },
  (req, res) => {
    const bucket = "myheartcounts-firebase.appspot.com"; // adjust this to your actual bucket name
    const file = `https://storage.googleapis.com/${bucket}/public/studyDefinition.json`;

    // Set CORS headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    // Redirect to the actual file
    res.redirect(302, file);
  },
);

export {
  beforeUserCreatedFunction as beforeUserCreated,
  beforeUserSignedInFunction as beforeUserSignedIn,
} from "./functions/blocking.js";
export * from "./functions/customSeed.js";
export * from "./functions/joinWaitlist.js";
export * from "./functions/updateStaticData.js";
export * from "./functions/updateUserInformation.js";
export * from "./functions/planNudges.js";
export * from "./functions/planPosttrialNudges.js";
export * from "./functions/sendNudges.js";
export * from "./functions/onUserQuestionnaireResponseWritten.js";
// Temporarily disabled 2026-06-09 to stop Firestore audit-log spam.
// export * from "./functions/deleteHealthSamples.js";
// Temporarily disabled 2026-05-06 for cost reduction.
// During the freeze, uploads accumulate at users/*/liveHealthSamples/** in GCS.
// Storage finalize triggers do NOT fire retroactively, so before re-enabling
// we MUST run scripts/backfillArchivedLiveHealthSamples.ts to drain the backlog.
// export * from "./functions/onArchivedLiveHealthSampleUploaded.js";
export * from "./functions/markAccountForDeletion.js";
export * from "./functions/markAccountForStudyReenrollment.js";
export * from "./functions/markAccountForStudyWithdrawal.js";
export * from "./functions/processUserDeletions.js";
// Temporarily disabled 2026-05-07 for cost-reduction freeze.
// Companion to the onArchivedLiveHealthSampleUploaded disable: while uploads
// are not being ingested, queue items would NOT_FOUND-retry-then-dead-letter
// Pausing the worker lets pending deletions accumulate in
// users/*/pendingHealthSampleDeletions until the
// trigger is back and backfill has populated the target docs.
// export * from "./functions/processPendingHealthSampleDeletions.js";
export * from "./functions/backfillExtendedActivityNudgesOptIn.js";
