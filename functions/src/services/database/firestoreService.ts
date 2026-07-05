// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  type BulkWriter,
  type BulkWriterOptions,
  type SetOptions,
  type Transaction,
  type Firestore,
} from "firebase-admin/firestore";
import { CollectionsService } from "./collections.js";
import { type Document, type DatabaseService } from "./databaseService.js";
import { Lazy } from "../../models/index.js";

export class FirestoreService implements DatabaseService {
  // Properties

  private readonly collectionsService = new Lazy(
    () => new CollectionsService(this.firestore),
  );
  private readonly firestore: Firestore;

  // Constructor

  constructor(firestore: Firestore) {
    this.firestore = firestore;
    // Settings are already applied globally in index.js
  }

  // Methods

  async getQuery<T>(
    query: (
      collectionsService: CollectionsService,
    ) => FirebaseFirestore.Query<T>,
  ): Promise<Array<Document<T>>> {
    const collection = await query(this.collectionsService.value).get();
    return collection.docs.map((doc) => ({
      id: doc.id,
      path: doc.ref.path,
      lastUpdate: doc.updateTime.toDate(),
      content: doc.data(),
    }));
  }

  async getDocument<T>(
    reference: (
      collectionsService: CollectionsService,
    ) => FirebaseFirestore.DocumentReference<T>,
  ): Promise<Document<T> | undefined> {
    const ref = reference(this.collectionsService.value);
    const doc = await ref.get();
    const data = doc.exists ? doc.data() : undefined;
    return doc.exists && data !== undefined ?
        {
          id: doc.id,
          path: doc.ref.path,
          // `lastUpdate` should not be undefined in this case
          lastUpdate: doc.updateTime?.toDate() ?? doc.readTime.toDate(),
          content: data,
        }
      : undefined;
  }

  async setDocument<T>(
    reference: (
      collectionsService: CollectionsService,
    ) => FirebaseFirestore.DocumentReference<T>,
    data: T,
    options?: SetOptions,
  ): Promise<void> {
    const ref = reference(this.collectionsService.value);
    if (options !== undefined) {
      await ref.set(data, options);
    } else {
      await ref.set(data);
    }
  }

  async bulkWrite(
    write: (
      collectionsService: CollectionsService,
      writer: BulkWriter,
    ) => Promise<void>,
    options?: BulkWriterOptions,
  ): Promise<void> {
    const writer = this.firestore.bulkWriter(options);
    await write(this.collectionsService.value, writer);
    await writer.close();
  }

  async listCollections<T>(
    docReference: (
      collections: CollectionsService,
    ) => FirebaseFirestore.DocumentReference<T>,
  ): Promise<FirebaseFirestore.CollectionReference[]> {
    return docReference(this.collectionsService.value).listCollections();
  }

  async runTransaction<T>(
    run: (
      collectionsService: CollectionsService,
      transaction: Transaction,
    ) => Promise<T> | T,
  ): Promise<T> {
    return this.firestore.runTransaction(async (transaction) =>
      run(this.collectionsService.value, transaction),
    );
  }
}
