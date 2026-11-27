// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import admin from "firebase-admin";
import { CachingStrategy } from "../../../models/index.js";
import { cleanupMocks, setupMockFirebase } from "../../../tests/setup.js";
import { getServiceFactory } from "../../factory/getServiceFactory.js";
import { type StaticDataService } from "./staticDataService.js";

describe("StaticDataService", () => {
  let staticDataService: StaticDataService;

  before(() => {
    setupMockFirebase();
    admin.firestore();
    staticDataService = getServiceFactory().staticData();
  });

  after(() => {
    cleanupMocks();
  });

  it("tests caching mechanism in SeedingService", async () => {
    // Get access to the service's internal methods by using type assertion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Testing private cache method requires type assertion
    const service = staticDataService as any;

    // Test the cache method with various strategies

    // First with expectCache, which should call retrieve
    let retrieveCalled = false;
    let createCalled = false;
    let saveCalled = false;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing private cache method for testing
    const result1 = await service.cache(
      CachingStrategy.expectCache,
      () => {
        retrieveCalled = true;
        return "retrieved-value";
      },
      () => {
        createCalled = true;
        return "created-value";
      },
      () => {
        saveCalled = true;
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(retrieveCalled).to.be.true;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(createCalled).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(saveCalled).to.be.false;
    expect(result1).to.equal("retrieved-value");

    // Reset flags
    retrieveCalled = false;
    createCalled = false;
    saveCalled = false;

    // Test with updateCache which should call create and save
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing private cache method for testing
    const result2 = await service.cache(
      CachingStrategy.updateCache,
      () => {
        retrieveCalled = true;
        return "retrieved-value";
      },
      () => {
        createCalled = true;
        return "created-value";
      },
      (value: string) => {
        saveCalled = true;
        expect(value).to.equal("created-value");
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(retrieveCalled).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(createCalled).to.be.true;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(saveCalled).to.be.true;
    expect(result2).to.equal("created-value");

    // Reset flags
    retrieveCalled = false;
    createCalled = false;
    saveCalled = false;

    // Test with ignoreCache which should call create but not save
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing private cache method for testing
    const result3 = await service.cache(
      CachingStrategy.ignoreCache,
      () => {
        retrieveCalled = true;
        return "retrieved-value";
      },
      () => {
        createCalled = true;
        return "created-value";
      },
      () => {
        saveCalled = true;
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(retrieveCalled).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(createCalled).to.be.true;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(saveCalled).to.be.false;
    expect(result3).to.equal("created-value");
  });

  it("tests error handling in SeedingService cache method", async () => {
    // Get access to the service's internal methods by using type assertion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Testing private cache method requires type assertion
    const service = staticDataService as any;

    // Test error handling in expectCache strategy
    let createCalled = false;
    let saveCalled = false;

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing private cache method for testing
      await service.cache(
        CachingStrategy.expectCache,
        () => {
          throw new Error("Retrieve failed");
        },
        () => {
          createCalled = true;
          return "created-value";
        },
        () => {
          saveCalled = true;
        },
      );
      expect.fail("Should have thrown an error");
    } catch (error) {
      // Should propagate error with expectCache

      expect(error).to.be.an("error");
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(createCalled).to.be.false;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(saveCalled).to.be.false;
    }

    // Reset flags
    createCalled = false;
    saveCalled = false;

    // Test error handling with updateCacheIfNeeded strategy
    // In this case, it should fall back to create when retrieve fails
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Accessing private cache method for testing
    const result = await service.cache(
      CachingStrategy.updateCacheIfNeeded,
      () => {
        throw new Error("Retrieve failed");
      },
      () => {
        createCalled = true;
        return "created-value";
      },
      (value: string) => {
        saveCalled = true;
        expect(value).to.equal("created-value");
      },
    );

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(createCalled).to.be.true;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(saveCalled).to.be.true;
    expect(result).to.equal("created-value");
  });
});
