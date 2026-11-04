// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { describe, it } from "mocha";
import {
  formatNudgeGenerationFailureMail,
  reportNudgeGenerationFailures,
} from "./nudgeFailureMail.js";

describe("nudgeFailureMail", () => {
  describe("formatNudgeGenerationFailureMail()", () => {
    it("lists every affected user with its error", () => {
      const mail = formatNudgeGenerationFailureMail(
        "onScheduleDailyNudgeCreation",
        [
          { userId: "user-a", error: "Error: connect ECONNREFUSED" },
          { userId: "user-b", error: "Error: 503 Service Unavailable" },
        ],
        "Predefined nudges were scheduled for these users instead.",
      );

      expect(mail.subject).to.equal(
        "[MyHeartCounts] LLM nudge generation failed for 2 users (onScheduleDailyNudgeCreation)",
      );
      expect(mail.text).to.include("could not generate LLM nudges for 2 users");
      expect(mail.text).to.include(
        "Predefined nudges were scheduled for these users instead.",
      );
      expect(mail.text).to.include("user-a: Error: connect ECONNREFUSED");
      expect(mail.text).to.include("user-b: Error: 503 Service Unavailable");
    });

    it("uses singular wording for a single user", () => {
      const mail = formatNudgeGenerationFailureMail(
        "onScheduleDailyPosttrialNudgeCreation",
        [{ userId: "user-a", error: "timeout" }],
        "No post-trial nudge was scheduled.",
      );

      expect(mail.subject).to.equal(
        "[MyHeartCounts] LLM nudge generation failed for 1 user (onScheduleDailyPosttrialNudgeCreation)",
      );
      expect(mail.text).to.include("for 1 user.");
    });
  });

  describe("reportNudgeGenerationFailures()", () => {
    it("sends nothing when there are no failures", async () => {
      const sent = await reportNudgeGenerationFailures("fn", [], "none");
      expect(sent).to.equal(false);
    });
  });
});
