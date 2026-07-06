// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { https } from "firebase-functions/v2";
import { disconnectHealthProvider } from "./disconnectHealthProvider.js";
import { getHealthProviderAuthUrl } from "./getHealthProviderAuthUrl.js";
import { HealthProviderId } from "../models/index.js";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";

describeWithEmulators("function: health provider callables", (env) => {
  it("getHealthProviderAuthUrl returns a URL and persists a pending auth request", async () => {
    const userId = await env.createUser({});

    const result = await env.call(
      getHealthProviderAuthUrl,
      { userId, provider: HealthProviderId.oura },
      { uid: userId },
    );

    expect(result.authorizationUrl).to.be.a("string");
    const requests = await env.firestore
      .collection("healthProviderAuthRequests")
      .where("userId", "==", userId)
      .get();
    expect(requests.docs).to.have.lengthOf(1);
    expect(requests.docs[0].data().provider).to.equal("oura");
  });

  it("getHealthProviderAuthUrl rejects a mismatched user id", async () => {
    const userId = await env.createUser({});
    try {
      await env.call(
        getHealthProviderAuthUrl,
        { userId: "someone-else", provider: HealthProviderId.oura },
        { uid: userId },
      );
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(https.HttpsError);
    }
  });

  it("disconnectHealthProvider leaves a disconnected status document", async () => {
    const userId = await env.createUser({});

    const result = await env.call(
      disconnectHealthProvider,
      { userId, provider: HealthProviderId.oura },
      { uid: userId },
    );

    expect(result.status).to.equal("disconnected");
    const connection = await env.firestore
      .collection("users")
      .doc(userId)
      .collection("healthProviderConnections")
      .doc("oura")
      .get();
    expect(connection.data()?.status).to.equal("disconnected");
  });
});
