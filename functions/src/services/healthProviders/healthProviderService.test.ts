// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unused-expressions */

import { expect } from "chai";
import { type Timestamp } from "firebase-admin/firestore";
import { decompress } from "fzstd";
import { type ObservationRecordDraft } from "./grove/drafts.js";
import { type GroveIdentityKey } from "./grove/identity.js";
import { instant } from "./grove/time.js";
import {
  type HealthProviderAdapter,
  type ProviderFetchResult,
} from "./healthProviderAdapter.js";
import {
  HealthProviderConnectionError,
  HealthProviderService,
} from "./healthProviderService.js";
import { ProviderHttpError } from "./httpClient.js";
import { HealthProviderId } from "../../models/index.js";
import { describeWithEmulators } from "../../tests/functions/testEnvironment.js";
import { FirestoreService } from "../database/firestoreService.js";

const PROVIDER_USER_ID = "provider-user-1";

const identityKey = (): GroveIdentityKey => ({
  key: Buffer.alloc(32, 9),
  keyId: "servicetest",
  epoch: "1",
  root: "https://myheartcounts.stanford.edu/fhir",
});

const heartRateRecord = (): ObservationRecordDraft => {
  const effective = instant(Date.parse("2026-01-01T12:00:00Z"));
  return {
    kind: "observations",
    sourceType: "getmeas:11",
    nativeRecordId: "hr-1",
    occurred: effective,
    outputs: [
      { measurement: "heart-rate", effective, value: { quantity: 62 } },
    ],
  };
};

const fetchResult = (
  overrides: Partial<ProviderFetchResult> = {},
): ProviderFetchResult => ({
  records: [heartRateRecord()],
  rawArchives: [],
  failures: [],
  ...overrides,
});

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
  fetchData: () => Promise.resolve(fetchResult()),
  ...overrides,
});

const fakeResponse = () => {
  const res = {
    statusCode: 0,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send() {
      return res;
    },
    json() {
      return res;
    },
    headersSent: false,
  };
  return res;
};

describeWithEmulators("service: HealthProviderService", (env) => {
  const bucket = () =>
    env.storage.bucket(`${process.env.GCLOUD_PROJECT}.appspot.com`);

  const newService = (overrides: Partial<HealthProviderAdapter> = {}) =>
    new HealthProviderService(
      new FirestoreService(env.firestore),
      bucket(),
      () => makeFakeAdapter(overrides),
      identityKey,
    );

  const stateFromAuthRequests = async (): Promise<string> => {
    const snapshot = await env.firestore
      .collection("healthProviderAuthRequests")
      .get();
    expect(snapshot.docs).to.have.lengthOf(1);
    return snapshot.docs[0].id;
  };

  const connectUser = async (
    service: HealthProviderService,
    userId: string,
  ): Promise<void> => {
    // The emulator environment resets Firestore between tests but not Storage.
    await bucket().deleteFiles({ prefix: `users/${userId}/` });
    await service.startConnection(userId, HealthProviderId.oura);
    const snapshot = await env.firestore
      .collection("healthProviderAuthRequests")
      .where("userId", "==", userId)
      .get();
    await service.completeConnection(snapshot.docs[0].id, "code");
  };

  const connection = async (userId: string) =>
    (
      await env.firestore
        .collection("users")
        .doc(userId)
        .collection("healthProviderConnections")
        .doc("oura")
        .get()
    ).data();

  const bundlePaths = async (userId: string): Promise<string[]> => {
    const [files] = await bucket().getFiles({
      prefix: `users/${userId}/providerHealthSamples/oura/`,
    });
    return files.map((file) => file.name);
  };

  const readBundle = async (path: string) => {
    const [compressed] = await bucket().file(path).download();
    return JSON.parse(Buffer.from(decompress(compressed)).toString("utf8")) as {
      resourceType: string;
      entry: Array<{ resource: Record<string, unknown> }>;
    };
  };

  const expireStoredToken = async (userId: string): Promise<void> => {
    await env.firestore
      .collection("users")
      .doc(userId)
      .collection("healthProviderTokens")
      .doc("oura")
      .set({ expiresAt: new Date(Date.now() - 3600_000) }, { merge: true });
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

  it("completeConnection stores tokens, a fresh status doc and the index", async () => {
    const service = newService();
    await service.startConnection("user-1", HealthProviderId.oura);
    const redirect = await service.completeConnection(
      await stateFromAuthRequests(),
      "auth-code",
    );
    expect(redirect).to.match(/\/oura\/connected$/);

    const tokens = await env.firestore
      .collection("users")
      .doc("user-1")
      .collection("healthProviderTokens")
      .doc("oura")
      .get();
    expect(tokens.data()?.providerUserId).to.equal(PROVIDER_USER_ID);

    const status = await connection("user-1");
    expect(status?.status).to.equal("connected");
    expect(status?.connectedAt).to.not.equal(null);
    expect(status?.lastSyncAt).to.equal(null);
    expect(status?.initialSyncCompletedAt).to.equal(null);

    const index = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(index.data()?.userIds).to.deep.equal(["user-1"]);
    expect(
      (await env.firestore.collection("healthProviderAuthRequests").get()).docs,
    ).to.have.lengthOf(0);
  });

  it("rejects a reused state with the provider-agnostic invalid_state reason", async () => {
    const service = newService();
    await service.startConnection("user-1", HealthProviderId.oura);
    const state = await stateFromAuthRequests();
    await service.completeConnection(state, "code");
    let thrown: unknown;
    try {
      await service.completeConnection(state, "code");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(HealthProviderConnectionError);
    expect((thrown as HealthProviderConnectionError).reason).to.equal(
      "invalid_state",
    );
  });

  it("initial sync uploads a Grove bundle and completes the initial import", async () => {
    let window: { since: Date; until: Date } | undefined;
    const service = newService({
      fetchData: ({ since, until }) => {
        window = { since, until };
        return Promise.resolve(fetchResult());
      },
    });
    await connectUser(service, "user-1");
    await service.runInitialSync("user-1", HealthProviderId.oura);

    expect(window?.since.getTime()).to.be.lessThan(
      Date.now() - 29 * 24 * 60 * 60 * 1000,
    );
    const status = await connection("user-1");
    expect(status?.lastSyncStatus).to.equal("ok");
    expect(status?.lastError).to.equal(null);
    expect(status?.initialSyncCompletedAt).to.not.equal(null);
    expect((status?.lastSyncAt as Timestamp).toMillis()).to.be.closeTo(
      Date.now(),
      60_000,
    );

    const paths = await bundlePaths("user-1");
    expect(paths).to.have.lengthOf(1);
    expect(paths[0]).to.match(/\/oura_getmeas-11_[0-9a-f]{24}\.json\.zstd$/);
    const bundle = await readBundle(paths[0]);
    expect(bundle.resourceType).to.equal("Bundle");
    expect(
      bundle.entry.map((entry) => entry.resource.resourceType),
    ).to.deep.equal(["Device", "Observation", "Provenance"]);
  });

  it("webhook ingests never advance lastSyncAt or complete the initial import", async () => {
    const service = newService();
    await connectUser(service, "user-1");
    const res = fakeResponse();
    await service.handleWebhook(
      HealthProviderId.oura,
      { method: "POST", body: {} } as never,
      res as never,
    );
    expect(res.statusCode).to.equal(204);
    const status = await connection("user-1");
    expect(status?.lastSyncStatus).to.equal("ok");
    expect(status?.lastSyncAt).to.equal(null);
    expect(status?.initialSyncCompletedAt).to.equal(null);
    expect(await bundlePaths("user-1")).to.have.lengthOf(1);
  });

  it("does not advance lastSyncAt on a partial sync", async () => {
    const service = newService({
      fetchData: () =>
        Promise.resolve(fetchResult({ failures: ["Oura sleep"] })),
    });
    await connectUser(service, "user-1");
    await service.backfillProvider(HealthProviderId.oura);
    const status = await connection("user-1");
    expect(status?.status).to.equal("connected");
    expect(status?.lastSyncStatus).to.equal("error");
    expect(status?.lastError).to.equal("partial_failure");
    expect(status?.lastSyncAt).to.equal(null);
    expect(status?.initialSyncCompletedAt).to.equal(null);
    // What did arrive is still stored.
    expect(await bundlePaths("user-1")).to.have.lengthOf(1);
  });

  it("archives raw payloads and describes them as recording documents", async () => {
    const rawPayload = { series: { "0": { steps: 12 } } };
    const service = newService({
      fetchData: () =>
        Promise.resolve(
          fetchResult({
            records: [],
            rawArchives: [
              {
                sourceType: "heartrate",
                dataType: "heartRate",
                typeText: "Oura heart-rate samples",
                payload: rawPayload,
              },
            ],
          }),
        ),
    });
    await connectUser(service, "user-1");
    await service.syncConnection("user-1", HealthProviderId.oura);

    const [bundlePath] = await bundlePaths("user-1");
    const bundle = await readBundle(bundlePath);
    const document = bundle.entry.find(
      (entry) => entry.resource.resourceType === "DocumentReference",
    )?.resource as { content: Array<{ attachment: { url: string } }> };
    const storagePath = document.content[0].attachment.url.replace(
      `gs://${bucket().name}/`,
      "",
    );
    expect(storagePath).to.match(/^users\/user-1\/ouraHealthSamples\//);
    const [compressed] = await bucket().file(storagePath).download();
    expect(
      JSON.parse(Buffer.from(decompress(compressed)).toString("utf8")),
    ).to.deep.equal(rawPayload);
  });

  it("keeps the connection connected on a transient failure, with a sanitized code", async () => {
    const service = newService({
      fetchData: () =>
        Promise.reject(new ProviderHttpError(500, "secret body", "fetch")),
    });
    await connectUser(service, "user-1");
    await service.backfillProvider(HealthProviderId.oura);
    const status = await connection("user-1");
    expect(status?.status).to.equal("connected");
    expect(status?.lastError).to.equal("provider_unavailable");
  });

  it("flips the connection to error on an auth failure", async () => {
    const service = newService({
      fetchData: () =>
        Promise.reject(new ProviderHttpError(401, "unauthorized", "fetch")),
    });
    await connectUser(service, "user-1");
    await service.backfillProvider(HealthProviderId.oura);
    const status = await connection("user-1");
    expect(status?.status).to.equal("error");
    expect(status?.lastError).to.equal("auth_failed");
  });

  it("flips the connection to error when the refresh token is rejected", async () => {
    const service = newService({
      refreshTokens: () => Promise.reject(new Error("invalid_grant")),
    });
    await connectUser(service, "user-1");
    await expireStoredToken("user-1");
    await service.backfillProvider(HealthProviderId.oura);
    expect((await connection("user-1"))?.status).to.equal("error");
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

  it("throttles manual syncs", async () => {
    const service = newService();
    await connectUser(service, "user-1");
    expect(await service.requestSync("user-1", HealthProviderId.oura)).to.equal(
      "started",
    );
    expect(await service.requestSync("user-1", HealthProviderId.oura)).to.equal(
      "throttled",
    );
    expect(await service.requestSync("user-2", HealthProviderId.oura)).to.equal(
      "not_connected",
    );
  });

  it("disconnect deletes tokens and index, and a later sync does not resurrect it", async () => {
    const service = newService();
    await connectUser(service, "user-1");
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

    await service.syncConnection("user-1", HealthProviderId.oura);
    expect((await connection("user-1"))?.status).to.equal("disconnected");
  });

  it("routes a shared provider account to every connected user and removes only the disconnecting one", async () => {
    const service = newService();
    await connectUser(service, "user-1");
    await connectUser(service, "user-2");
    const index = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(index.data()?.userIds).to.have.members(["user-1", "user-2"]);
    await service.disconnect("user-1", HealthProviderId.oura);
    const after = await env.firestore
      .collection("healthProviderUserIndex")
      .doc(`oura:${PROVIDER_USER_ID}`)
      .get();
    expect(after.data()?.userIds).to.deep.equal(["user-2"]);
  });

  it("clamps a webhook window so a forged far-past 'since' can't force an unbounded fetch", async () => {
    let captured: { since: Date; until: Date } | undefined;
    const service = newService({
      handleWebhook: () => ({
        kind: "notifications",
        notifications: [
          {
            providerUserId: PROVIDER_USER_ID,
            since: new Date(0),
            until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
          },
        ],
      }),
      fetchData: ({ since, until }) => {
        captured = { since, until };
        return Promise.resolve(fetchResult({ records: [] }));
      },
    });
    await connectUser(service, "user-1");
    const res = fakeResponse();
    await service.handleWebhook(
      HealthProviderId.oura,
      { method: "POST", body: {} } as never,
      res as never,
    );
    expect(res.statusCode).to.equal(204);
    if (captured === undefined) throw new Error("fetchData not called");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    expect(captured.since.getTime()).to.be.greaterThan(eightDaysAgo);
    expect(captured.until.getTime()).to.be.lessThan(Date.now() + 1000);
  });
});
