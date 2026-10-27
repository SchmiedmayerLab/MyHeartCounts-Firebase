// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import fs from "fs";
import { type CollectionReference } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { z } from "zod";
import { CachingStrategy } from "../../models/index.js";

export interface SeedingOptions {
  useIndicesAsKeys: boolean;
  path: string;
}

export class SeedingService {
  private useIndicesAsKeys: boolean;
  private path: string;

  constructor(options: SeedingOptions) {
    this.useIndicesAsKeys = options.useIndicesAsKeys;
    this.path = options.path;
  }

  protected async cache<T>(
    strategy: CachingStrategy,
    retrieve: () => Promise<T> | T,
    create: () => Promise<T> | T,
    save: (value: T) => Promise<void> | void,
  ): Promise<T> {
    if (
      strategy === CachingStrategy.expectCache ||
      strategy === CachingStrategy.updateCacheIfNeeded
    ) {
      try {
        return await retrieve();
      } catch (error) {
        logger.error("Could not retrieve cached data:", error);
        if (strategy === CachingStrategy.expectCache) throw error;
      }
    }

    const result = await create();
    if (
      strategy === CachingStrategy.updateCache ||
      strategy === CachingStrategy.updateCacheIfNeeded
    ) {
      await save(result);
    }
    return result;
  }

  protected setCollection<T>(
    collection: CollectionReference<T>,
    data: T[] | Record<string, T>,
    transaction: FirebaseFirestore.Transaction,
  ) {
    // Helper function to clean data objects
    const cleanObject = <T>(obj: T): T => {
      // Parse and stringify to remove undefined values
      return JSON.parse(JSON.stringify(obj)) as T;
    };

    if (Array.isArray(data)) {
      for (let index = 0; index < data.length; index++) {
        const document =
          this.useIndicesAsKeys ?
            collection.doc(String(index))
          : collection.doc();

        // Clean the data object to remove undefined values
        const cleanData = cleanObject(data[index]);
        transaction.set(document, cleanData, { merge: true });
      }
    } else {
      for (const key of Object.keys(data)) {
        // Clean the data object to remove undefined values
        const cleanData = cleanObject(data[key]);
        transaction.set(collection.doc(key), cleanData, { merge: true });
      }
    }
  }

  protected async deleteCollection<T>(
    reference: CollectionReference<T>,
    transaction: FirebaseFirestore.Transaction,
  ) {
    const result = await transaction.get(reference);
    for (const doc of result.docs) {
      transaction.delete(doc.ref);
    }
  }

  protected filesExist(...filenames: string[]) {
    return filenames.reduce(
      (acc, filename) => acc && fs.existsSync(this.path + filename),
      true,
    );
  }

  protected readJSONArray<Schema extends z.ZodTypeAny>(
    filename: string,
    schema: Schema,
  ): Array<z.output<Schema>> {
    return schema
      .array()
      .parse(JSON.parse(fs.readFileSync(this.path + filename, "utf8")));
  }

  protected readJSONRecord<Schema extends z.ZodTypeAny>(
    filename: string,
    schema: Schema,
  ): Record<string, z.output<Schema>> {
    return z
      .record(schema)
      .parse(JSON.parse(fs.readFileSync(this.path + filename, "utf8")));
  }

  protected writeJSON(filename: string, data: unknown) {
    fs.writeFileSync(
      this.path + filename,
      JSON.stringify(data, undefined, "  "),
    );
  }
}
