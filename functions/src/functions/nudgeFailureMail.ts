// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  type CoordinatorMail,
  sendCoordinatorMail,
} from "./coordinatorMail.js";

export interface NudgeGenerationFailure {
  userId: string;
  error: string;
}

export const formatNudgeGenerationFailureMail = (
  functionName: string,
  failures: NudgeGenerationFailure[],
  consequence: string,
): CoordinatorMail => {
  const count = failures.length;
  const users = `${count} user${count === 1 ? "" : "s"}`;
  return {
    subject: `[MyHeartCounts] LLM nudge generation failed for ${users} (${functionName})`,
    text: [
      `The ${functionName} run at ${new Date().toISOString()} could not generate LLM nudges for ${users}.`,
      `All retry attempts against the LLM backend failed. ${consequence}`,
      ``,
      `Check the Cloud Functions logs and the LLM gateway status (LLM_API_BASE_URL secret).`,
      ``,
      `--- Affected users ---`,
      ...failures.map((failure) => `${failure.userId}: ${failure.error}`),
    ].join("\n"),
  };
};

export const reportNudgeGenerationFailures = async (
  functionName: string,
  failures: NudgeGenerationFailure[],
  consequence: string,
): Promise<boolean> =>
  failures.length > 0 &&
  sendCoordinatorMail(
    formatNudgeGenerationFailureMail(functionName, failures, consequence),
  );
