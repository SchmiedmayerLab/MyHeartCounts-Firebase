// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { expect } from "chai";
import { describe, it } from "mocha";
import { forEachWithConcurrency } from "./forEachWithConcurrency.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("forEachWithConcurrency", () => {
  it("processes every item without exceeding the concurrency limit", async () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    const processed: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    await forEachWithConcurrency(items, 3, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(5);
      processed.push(item);
      inFlight--;
    });

    expect(processed.slice().sort((a, b) => a - b)).to.deep.equal(items);
    expect(maxInFlight).to.equal(3);
  });

  it("starts items in their original order", async () => {
    const started: number[] = [];

    await forEachWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      await sleep(1);
    });

    expect(started).to.deep.equal([0, 1, 2, 3, 4]);
  });

  it("handles fewer items than the concurrency limit and empty input", async () => {
    const processed: string[] = [];

    await forEachWithConcurrency(["a", "b"], 10, async (item) => {
      await Promise.resolve();
      processed.push(item);
    });
    await forEachWithConcurrency([], 10, async () => {
      await Promise.resolve();
      expect.fail("worker must not be called for empty input");
    });

    expect(processed).to.deep.equal(["a", "b"]);
  });

  it("treats a concurrency below 1 as 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await forEachWithConcurrency([1, 2, 3], 0, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(1);
      inFlight--;
    });

    expect(maxInFlight).to.equal(1);
  });

  it("keeps processing after a rejection and rethrows the first error", async () => {
    const processed: number[] = [];

    let caught: unknown;
    try {
      await forEachWithConcurrency([1, 2, 3, 4], 2, async (item) => {
        await sleep(1);
        if (item === 2) throw new Error("first failure");
        if (item === 3) throw new Error("second failure");
        processed.push(item);
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.equal("first failure");
    expect(processed.slice().sort((a, b) => a - b)).to.deep.equal([1, 4]);
  });
});
