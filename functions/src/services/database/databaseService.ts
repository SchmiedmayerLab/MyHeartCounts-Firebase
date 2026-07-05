// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  type Transaction,
  type BulkWriter,
  type BulkWriterOptions,
  type SetOptions,
} from "firebase-admin/firestore";
import { type CollectionsService } from "./collections.js";

export interface Document<Content> {
  id: string;
  path: string;
  lastUpdate: Date;
  content: Content;
}

export interface DatabaseService {
  getQuery<T>(
    query: (
      collectionsService: CollectionsService,
    ) => FirebaseFirestore.Query<T>,
  ): Promise<Array<Document<T>>>;

  getDocument<T>(
    reference: (
      collectionsService: CollectionsService,
    ) => FirebaseFirestore.DocumentReference<T>,
  ): Promise<Document<T> | undefined>;

  setDocument<T>(
    reference: (
      collectionsService: CollectionsService,
    ) => FirebaseFirestore.DocumentReference<T>,
    data: T,
    options?: SetOptions,
  ): Promise<void>;

  bulkWrite(
    write: (
      collectionsService: CollectionsService,
      writer: BulkWriter,
    ) => Promise<void>,
    options?: BulkWriterOptions,
  ): Promise<void>;

  listCollections<T>(
    collection: (
      collections: CollectionsService,
    ) => FirebaseFirestore.DocumentReference<T>,
  ): Promise<FirebaseFirestore.CollectionReference[]>;

  runTransaction<T>(
    run: (
      collectionsService: CollectionsService,
      transaction: Transaction,
    ) => Promise<T> | T,
  ): Promise<T>;
}
