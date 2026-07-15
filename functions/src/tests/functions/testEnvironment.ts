// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import http from "http";
import { expect } from "chai";
import admin from "firebase-admin";
import { type DocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import { type Change } from "firebase-functions";
import { type CloudEvent, type CloudFunction } from "firebase-functions/v2";
import {
  type CallableFunction,
  type CallableRequest,
} from "firebase-functions/v2/https";
import firebaseFunctionsTest from "firebase-functions-test";
import { type WrappedV2Function } from "firebase-functions-test/lib/v2";
import { Lazy, User } from "../../models/index.js";
import { CollectionsService } from "../../services/database/collections.js";
import { getServiceFactory } from "../../services/factory/getServiceFactory.js";
import { type ServiceFactory } from "../../services/factory/serviceFactory.js";
import { TestFlags } from "../testFlags.js";

export const describeWithEmulators = (
  title: string,
  perform: (env: EmulatorTestEnvironment) => void,
) => {
  describe(title, () => {
    if (TestFlags.connectsToEmulator) {
      const env = EmulatorTestEnvironment.instance;

      beforeEach(async () => {
        await env.cleanup();
      });

      perform(env);
    } else {
      it("skipped due to missing emulator", () => {
        expect.fail("skipped test");
      });
    }
  });
};

export class EmulatorTestEnvironment {
  // Static Properties

  private static lazyInstance = new Lazy<EmulatorTestEnvironment>(() => {
    process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
    admin.initializeApp();
    return new EmulatorTestEnvironment();
  });

  static get instance() {
    return this.lazyInstance.value;
  }

  // Stored Properties

  readonly auth = admin.auth();
  readonly firestore = admin.firestore();
  readonly storage = admin.storage();

  readonly collections = new CollectionsService(this.firestore);
  readonly factory: ServiceFactory;

  private readonly wrapper = firebaseFunctionsTest();

  private areTriggersEnabled = true;

  // Constructor

  private constructor() {
    this.factory = getServiceFactory();
  }

  // Methods

  async call<Input, Output>(
    func: CallableFunction<Input, Output>,
    input: Input,
    auth: { uid: string; token?: object },
  ): Promise<Output> {
    const wrapped = this.wrapper.wrap(func);
    return wrapped({
      data: input,
      auth: {
        uid: auth.uid,
        token: {
          ...(auth.token ?? {}),
        },
      },
    } as unknown as CallableRequest<Input>);
  }

  async callAnonymous<Input, Output>(
    func: CallableFunction<Input, Output>,
    input: Input,
  ): Promise<Output> {
    const wrapped = this.wrapper.wrap(func);
    return wrapped({
      data: input,
    } as unknown as CallableRequest<Input>);
  }

  wrapTrigger<T extends CloudEvent<unknown>>(
    func: CloudFunction<T>,
  ): WrappedV2Function<T> {
    return this.wrapper.wrap(func);
  }

  async cleanup() {
    const collections = await admin.firestore().listCollections();
    for (const collection of collections) {
      await admin.firestore().recursiveDelete(collection);
    }
    const usersResult = await admin.auth().listUsers();
    for (const user of usersResult.users) {
      await admin.auth().deleteUser(user.uid);
    }
  }

  createChange<T extends Record<string, unknown>>(
    path: string,
    before: T | undefined,
    after: T | undefined,
  ): Change<DocumentSnapshot> {
    const beforeSnapshot: DocumentSnapshot =
      before !== undefined ?
        (this.wrapper.firestore.makeDocumentSnapshot(
          before,
          path,
        ) as DocumentSnapshot)
      : this.createEmptyDocumentSnapshot(path);

    const afterSnapshot: DocumentSnapshot =
      after !== undefined ?
        (this.wrapper.firestore.makeDocumentSnapshot(
          after,
          path,
        ) as DocumentSnapshot)
      : this.createEmptyDocumentSnapshot(path);
    return this.wrapper.makeChange(beforeSnapshot, afterSnapshot);
  }

  async createUser(
    options: {
      type?: string;
      disabled?: boolean;
      dateOfEnrollment?: Date;
      lastActiveDate?: Date;
      lastUploadDate?: Date;
    } & admin.auth.CreateRequest,
  ) {
    const authUser = await this.auth.createUser(options);
    await this.collections.users.doc(authUser.uid).set(
      new User({
        disabled: options.disabled ?? false,
        dateOfEnrollment: options.dateOfEnrollment ?? new Date(),
        lastActiveDate: options.lastActiveDate ?? new Date(),
        extendedActivityNudgesOptIn: true,
        lastUploadDate: options.lastUploadDate ?? new Date(),
      }),
    );
    return authUser.uid;
  }

  // Helpers

  private createEmptyDocumentSnapshot(path: string): DocumentSnapshot {
    return {
      exists: false,
      id: path.split("/").at(-1) ?? path,
      ref: this.firestore.doc(path),
      readTime: Timestamp.now(),
      get() {
        return undefined;
      },
      isEqual() {
        return false;
      },
      data: () => undefined,
    };
  }

  private async post(url: string, data: object) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          if (response.statusCode === undefined) {
            reject(new Error("statusCode=undefined"));
            return;
          } else if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`statusCode=${response.statusCode}`));
            return;
          }
          response.on("end", resolve);
        },
      );
      request.on("error", reject);
      request.write(JSON.stringify(data));
      request.end();
    });
  }
}
