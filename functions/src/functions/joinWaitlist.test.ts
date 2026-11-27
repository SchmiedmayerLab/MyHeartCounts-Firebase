// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import { https } from "firebase-functions/v2";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";
import { joinWaitlist } from "./joinWaitlist.js";

describeWithEmulators("function: joinWaitlist", (env) => {
  it("successfully adds an entry to the waitlist", async () => {
    await env.callAnonymous(joinWaitlist, {
      region: "US",
      email: "test@example.com",
    });

    const snapshot = await env.firestore.collection("waitlist").get();
    expect(snapshot.docs).to.have.lengthOf(1);

    const data = snapshot.docs[0].data();
    expect(data.region).to.equal("US");
    expect(data.email).to.equal("test@example.com");
    expect(data.createdAt).to.exist;
  });

  it("rejects invalid email addresses", async () => {
    try {
      await env.callAnonymous(joinWaitlist, {
        region: "US",
        email: "not-an-email",
      });
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("invalid-argument");
    }
  });

  it("rejects invalid ISO country code", async () => {
    try {
      await env.callAnonymous(joinWaitlist, {
        region: "INVALID",
        email: "test@example.com",
      });
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("invalid-argument");
    }
  });

  it("rejects lowercase country codes", async () => {
    try {
      await env.callAnonymous(joinWaitlist, {
        region: "us",
        email: "test@example.com",
      });
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("invalid-argument");
    }
  });

  it("rejects missing fields", async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await env.callAnonymous(joinWaitlist, {} as any);
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
      expect((error as https.HttpsError).code).to.equal("invalid-argument");
    }
  });

  it("allows multiple entries for different regions", async () => {
    await env.callAnonymous(joinWaitlist, {
      region: "US",
      email: "test@example.com",
    });
    await env.callAnonymous(joinWaitlist, {
      region: "DE",
      email: "test@example.com",
    });

    const snapshot = await env.firestore.collection("waitlist").get();
    expect(snapshot.docs).to.have.lengthOf(2);
  });

  it("is idempotent for duplicate region and email", async () => {
    await env.callAnonymous(joinWaitlist, {
      region: "US",
      email: "test@example.com",
    });
    await env.callAnonymous(joinWaitlist, {
      region: "US",
      email: "test@example.com",
    });

    const snapshot = await env.firestore.collection("waitlist").get();
    expect(snapshot.docs).to.have.lengthOf(1);

    const data = snapshot.docs[0].data();
    expect(data.region).to.equal("US");
    expect(data.email).to.equal("test@example.com");
  });

  it("normalizes email for idempotency", async () => {
    await env.callAnonymous(joinWaitlist, {
      region: "US",
      email: " Test@Example.COM ",
    });
    await env.callAnonymous(joinWaitlist, {
      region: "US",
      email: "test@example.com",
    });

    const snapshot = await env.firestore.collection("waitlist").get();
    expect(snapshot.docs).to.have.lengthOf(1);

    const data = snapshot.docs[0].data();
    expect(data.region).to.equal("US");
    expect(data.email).to.equal("test@example.com");
  });
});
