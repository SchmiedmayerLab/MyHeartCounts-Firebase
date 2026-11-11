// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

/**
 * Calls `worker` for every item, keeping at most `concurrency` calls in
 * flight and starting items in their original order. Resolves once every
 * call has settled. A rejected call does not stop the remaining items; the
 * first rejection is rethrown after all items have been processed.
 */
export const forEachWithConcurrency = async <T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  let nextIndex = 0;
  let firstError: Error | undefined;

  const runnerCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    items.length,
  );

  const runners = Array.from({ length: runnerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex++;
      try {
        await worker(item);
      } catch (error) {
        firstError ??=
          error instanceof Error ? error : new Error(String(error));
      }
    }
  });

  await Promise.all(runners);

  if (firstError) throw firstError;
};
