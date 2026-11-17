// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { describe, it } from "mocha";
import { sendCoordinatorMail } from "./coordinatorMail.js";

describe("coordinatorMail", () => {
  describe("sendCoordinatorMail()", () => {
    it("skips sending when SMTP is not configured", async () => {
      delete process.env.SMTP_HOST;
      const sent = await sendCoordinatorMail({ subject: "test", text: "test" });
      expect(sent).to.equal(false);
    });
  });
});
