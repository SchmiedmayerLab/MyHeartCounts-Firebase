// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import { type HealthProviderAdapter } from "./healthProviderAdapter.js";
import { HealthProviderService } from "./healthProviderService.js";
import { ProviderHttpError } from "./httpClient.js";
import { buildProviderObservation } from "./observationBuilder.js";
import { MetricSpecs } from "./providerCodes.js";
import { HealthProviderId } from "../../models/index.js";
import { describeWithEmulators } from "../../tests/functions/testEnvironment.js";
import { FirestoreService } from "../database/firestoreService.js";

const PROVIDER_USER_ID = "provider-user-1";

/** A fake Oura-shaped adapter that never touches the network. */
const makeFakeAdapter = (
  overrides: Partial<HealthProviderAdapter> = {},
): HealthProviderAdapter => ({
  id: HealthProviderId.oura,
  scopes: ["daily", "heartrate"],
  usesPkce: false,
  buildAuthorizationUrl: ({ state, redirectUri }) =>
    `https://provider.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchangeCode: () =>
    Promise.resolve({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ["daily", "heartrate"],
      providerUserId: PROVIDER_USER_ID,
    }),
  refreshTokens: () =>
    Promise.resolve({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ["daily", "heartrate"],
      providerUserId: PROVIDER_USER_ID,
    }),
  revoke: () => Promise.resolve(),
  ensureSubscription: () => Promise.resolve({ subscriptionId: "sub-1" }),
  removeSubscription: () => Promise.resolve(),
  handleWebhook: () => ({
    kind: "notifications",
    notifications: [{ providerUserId: PROVIDER_USER_ID }],
  }),
  fetchObservations: ({ subject }) =>
    Promise.resolve([
      buildProviderObservation({
        provider: HealthProviderId.oura,
        sourceName: "Oura",
        subject,
        spec: MetricSpecs.heartRate,
        value: 62,
        effective: new Date("2026-01-01T12:00:00Z"),
        sampleId: "hr-1",
      }),
    ]),
  ...overrides,
});

describeWithEmulators("service: HealthProviderService", (env) => {
  const newService = (overrides: Partial<HealthProviderAdapter> = {}) =>
    new HealthProviderService(new FirestoreService(env.firestore), () =>
      makeFakeAdapter(overrides),
    );

  const connectUser = async (
    service: HealthProviderService,
    userId: string,
  ): Promise<void> => {
    await service.startConnection(userId, HealthProviderId.oura);
    const snapshot = await env.firestore
      .collection("healthProviderAuthRequests")
      .where("userId", "==", userId)
      .get();
    await service.completeConnection(snapshot.docs[0].id, "code");
  };

  const connectionStatus = async (
    userId: string,
  ): Promise<string | undefined> =>
    (
      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("healthProviderConnections")
        .doc("oura")
        .get()
    ).data()?.status as string | undefined;

  const stateFromAuthRequests = async (): Promise<string> => {
    const snapshot = await env.firestore
      .collection("healthProviderAuthRequests")
      .get();
    expect(snapshot.docs).to.have.lengthOf(1);
    return snapshot.docs[0].id;
  };

  it("startConnection persists a pending auth request and returns a URL", async () => {
    const service = newService();
    const url = await service.startConnection("user-1", HealthProviderId.oura);

    const state = await stateFromAuthRequests();
    expect(url).to.contain(`state=${state}`);

    const request = await env.firestore
      .collection("healthProviderAuthRequests")
      .doc(state)
      .get();
    expect(request.data()?.userId).to.equal("user-1");
    expect(request.data()?.provider).to.equal("oura");
  });

  it("completeConnection stores tokens, status and reverse-lookup index", async () => {
    const service = newService();
    await service.startConnection("user-1", HealthProviderId.oura);
    const state = await stateFromAuthRequests();

    await service.completeConnection(state, "auth-code");

    // Tokens stored server-side.
    const tokens = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderTokens")
      .doc("oura")
      .get();
    expect(tokens.exists).to.be.true;
    expect(tokens.data()?.providerUserId).to.equal(PROVIDER_USER_ID);
    expect(tokens.data()?.subscriptionId).to.equal("sub-1");

    // Client-readable status: connected, with lastSyncAt seeded in the past so
    // the scheduled backfill pulls the initial history window (connect itself
    // does not fetch synchronously — that keeps the OAuth callback fast).
    const connection = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderConnections")
      .doc("oura")
      .get();
    expect(connection.data()?.status).to.equal("connected");
    const seededSyncAt = connection.data()?.lastSyncAt as
      | { toDate: () => Date }
      | undefined;
    expect(seededSyncAt?.toDate().getTime()).to.be.lessThan(Date.now());

    // Reverse-lookup index for webhook routing.
    const index = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(index.data()?.userIds).to.deep.equal(["user-1"]);

    // The auth request was consumed.
    const remaining = await env.firestore
      .collection("healthProviderAuthRequests")
      .get();
    expect(remaining.docs).to.have.lengthOf(0);
  });

  it("handleWebhook routes a provider notification to the right user and ingests", async () => {
    const service = newService();
    await service.startConnection("user-1", HealthProviderId.oura);
    await service.completeConnection(await stateFromAuthRequests(), "code");

    // Remove the observation written during completeConnection to prove the
    // webhook path re-ingests it.
    await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("OuraObservations_heartRate")
      .doc("oura-hr-1")
      .delete();

    let statusCode = 0;
    const fakeRes = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      send() {
        return this;
      },
      json() {
        return this;
      },
      headersSent: false,
    };

    await service.handleWebhook(
      HealthProviderId.oura,
      { method: "POST", body: {} } as never,
      fakeRes as never,
    );

    expect(statusCode).to.equal(204);
    const observation = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("OuraObservations_heartRate")
      .doc("oura-hr-1")
      .get();
    expect(observation.exists).to.be.true;
  });

  it("disconnect deletes tokens and index and marks the status disconnected", async () => {
    const service = newService();
    await service.startConnection("user-1", HealthProviderId.oura);
    await service.completeConnection(await stateFromAuthRequests(), "code");

    await service.disconnect("user-1", HealthProviderId.oura);

    const tokens = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderTokens")
      .doc("oura")
      .get();
    expect(tokens.exists).to.be.false;

    const index = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(index.exists).to.be.false;

    const connection = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderConnections")
      .doc("oura")
      .get();
    expect(connection.data()?.status).to.equal("disconnected");
  });

  it("routes a shared provider account to every connected user and removes only the disconnecting one", async () => {
    const service = newService();
    await connectUser(service, "user-1");
    await connectUser(service, "user-2");

    // Both MHC accounts share the same provider user id in the index.
    const index = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(index.data()?.userIds).to.have.members(["user-1", "user-2"]);

    // Disconnecting user-1 leaves user-2 still routed.
    await service.disconnect("user-1", HealthProviderId.oura);
    const after = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(after.data()?.userIds).to.deep.equal(["user-2"]);
  });

  it("disconnectAll tears down every connection and index entry for a user", async () => {
    const service = newService();
    await connectUser(service, "user-1");

    await service.disconnectAll("user-1");

    const tokens = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderTokens")
      .doc("oura")
      .get();
    expect(tokens.exists).to.be.false;
    const index = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(index.exists).to.be.false;
  });

  it("keeps the connection 'connected' on a transient sync failure", async () => {
    const service = newService({
      fetchObservations: () =>
        Promise.reject(new ProviderHttpError(500, "server error", "fetch")),
    });
    await connectUser(service, "user-1");

    await service.backfillProvider(HealthProviderId.oura);

    expect(await connectionStatus("user-1")).to.equal("connected");
    const connection = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderConnections")
      .doc("oura")
      .get();
    expect(connection.data()?.lastSyncStatus).to.equal("error");
  });

  it("flips the connection to 'error' on an auth failure", async () => {
    const service = newService({
      fetchObservations: () =>
        Promise.reject(new ProviderHttpError(401, "unauthorized", "fetch")),
    });
    await connectUser(service, "user-1");

    await service.backfillProvider(HealthProviderId.oura);

    expect(await connectionStatus("user-1")).to.equal("error");
  });

  it("flips the connection to 'error' when the refresh token is rejected", async () => {
    const service = newService({
      refreshTokens: () => Promise.reject(new Error("invalid_grant")),
    });
    await connectUser(service, "user-1");
    await expireStoredToken("user-1");

    await service.backfillProvider(HealthProviderId.oura);

    expect(await connectionStatus("user-1")).to.equal("error");
  });

  it("refreshes and persists a rotated token when the stored one is expired", async () => {
    const service = newService();
    await connectUser(service, "user-1");
    await expireStoredToken("user-1");

    await service.backfillProvider(HealthProviderId.oura);

    const tokens = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderTokens")
      .doc("oura")
      .get();
    expect(tokens.data()?.accessToken).to.equal("access-2");
    expect(tokens.data()?.refreshToken).to.equal("refresh-2");
  });

  it("clamps a webhook window so a forged far-past 'since' can't force an unbounded fetch", async () => {
    let captured: { since: Date; until: Date } | undefined;
    const service = newService({
      handleWebhook: () => ({
        kind: "notifications",
        notifications: [
          {
            providerUserId: PROVIDER_USER_ID,
            since: new Date(0), // 1970 — attacker-supplied
            until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // future
          },
        ],
      }),
      fetchObservations: ({ since, until }) => {
        captured = { since, until };
        return Promise.resolve([]);
      },
    });
    await connectUser(service, "user-1");

    let statusCode = 0;
    const fakeRes = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      send() {
        return this;
      },
      json() {
        return this;
      },
      headersSent: false,
    };
    await service.handleWebhook(
      HealthProviderId.oura,
      { method: "POST", body: {} } as never,
      fakeRes as never,
    );

    expect(statusCode).to.equal(204);
    if (captured === undefined) throw new Error("fetchObservations not called");
    // `since` clamped to at most ~7 days back, `until` to no later than now.
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    expect(captured.since.getTime()).to.be.greaterThan(eightDaysAgo);
    expect(captured.until.getTime()).to.be.lessThan(Date.now() + 1000);
  });

  const expireStoredToken = async (userId: string): Promise<void> => {
    await env.firestore
      .collection("users")
      .doc(userId)
      .collection("healthProviderTokens")
      .doc("oura")
      .set({ expiresAt: new Date(Date.now() - 3600_000) }, { merge: true });
  };
});
