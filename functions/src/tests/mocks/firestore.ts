// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import {
  Timestamp,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";

export class MockFirestore {
  collections = new Map<string, Map<string, unknown>>();

  collection(path: string) {
    return new MockFirestoreCollectionRef(this, path);
  }

  doc(path: string) {
    return new MockFirestoreDocRef(this, path);
  }

  collectionGroup(collectionId: string) {
    // Implement collectionGroup to find all subcollections with the given ID
    const result = new MockFirestoreCollectionGroupRef(this, collectionId);
    return result;
  }

  replaceAll(record: Record<string, Record<string, unknown>>) {
    this.collections = new Map<string, Map<string, unknown>>();
    for (const collectionName in record) {
      const collection = record[collectionName];
      const collectionMap = new Map<string, unknown>();
      this.collections.set(collectionName, collectionMap);
      for (const docName in collection) {
        collectionMap.set(docName, collection[docName]);
      }
    }
  }

  runTransaction(
    callback: (transaction: MockFirestoreTransaction) => Promise<void>,
  ) {
    return callback(new MockFirestoreTransaction());
  }

  bulkWriter(): MockFirestoreBulkWriter {
    return new MockFirestoreBulkWriter();
  }

  recursiveDelete(reference: MockFirestoreRef) {
    if (reference instanceof MockFirestoreCollectionRef) {
      this.collections.delete(reference.path);
    } else if (reference instanceof MockFirestoreDocRef) {
      reference.delete();
    } else {
      throw new Error("Unsupported reference type");
    }
    this.collections.forEach((_, key) => {
      if (key.startsWith(reference.path + "/")) {
        this.collections.delete(key);
      }
    });
  }
}

class MockFirestoreBulkWriter {
  close() {
    return;
  }
}

class MockFirestoreTransaction {
  get(reference: MockFirestoreRef) {
    return (reference as MockFirestoreRef & { get(): unknown }).get();
  }

  create(reference: MockFirestoreDocRef, data: unknown) {
    reference.create(data);
  }

  set(reference: MockFirestoreDocRef, data: unknown) {
    reference.set(data);
  }

  update(reference: MockFirestoreDocRef, data: Record<string, unknown>) {
    const rawData = reference.get().data();
    const existingData = (rawData as Record<string, unknown> | undefined) ?? {};
    const mergedData = { ...existingData, ...data };
    reference.set(mergedData);
  }

  delete(reference: MockFirestoreDocRef) {
    reference.delete();
  }
}

class MockFirestoreRef {
  firestore: MockFirestore;
  path: string;

  constructor(firestore: MockFirestore, path: string) {
    this.firestore = firestore;
    this.path = path;
  }

  collection(path: string) {
    return new MockFirestoreCollectionRef(
      this.firestore,
      `${this.path}/${path}`,
    );
  }

  doc(path: string) {
    return new MockFirestoreDocRef(this.firestore, `${this.path}/${path}`);
  }
}

class MockFirestoreCollectionRef extends MockFirestoreRef {
  get() {
    const result = this.firestore.collections.get(this.path) ?? new Map();
    const docs: Array<{
      id: string;
      exists: boolean;
      ref: MockFirestoreDocRef;
      updateTime: Timestamp;
      data: () => unknown;
    }> = [];
    let size = 0;
    result.forEach((value: unknown, key: string) => {
      size += 1;
      docs.push({
        id: key,
        exists: true,
        ref: this.doc(key),
        updateTime: Timestamp.now(),
        data: () => value,
      });
    });
    return {
      docs: docs,
      ref: this as unknown as MockFirestoreCollectionRef,
      size: size,
    };
  }

  where(
    field: string,
    operator: string,
    value: unknown,
  ): MockFirestoreCollectionRef {
    return new MockFirestoreFilteredCollectionRef(this, field, operator, value);
  }

  limit(limit: number): MockFirestoreCollectionRef {
    return new MockFirestoreLimitedCollectionRef(this, limit);
  }

  withConverter<T>(
    converter: FirestoreDataConverter<T>,
  ): MockFirestoreCollectionRef {
    return new MockFirestoreConvertedCollectionRef(this, converter);
  }
}

class MockFirestoreConvertedCollectionRef<
  T,
> extends MockFirestoreCollectionRef {
  readonly ref: MockFirestoreCollectionRef;
  readonly converter: FirestoreDataConverter<T>;

  constructor(
    ref: MockFirestoreCollectionRef,
    converter: FirestoreDataConverter<T>,
  ) {
    super(ref.firestore, ref.path);
    this.ref = ref;
    this.converter = converter;
  }

  get() {
    const docs = this.ref.get().docs.map((doc) => {
      const newData = this.converter.fromFirestore(
        doc as unknown as QueryDocumentSnapshot,
      );
      return {
        exists: doc.exists,
        id: doc.id,
        ref: doc.ref,
        updateTime: doc.updateTime,
        data: () => newData,
      };
    });

    return {
      docs: docs,
      ref: this as unknown as MockFirestoreConvertedCollectionRef<T>,
      size: docs.length,
    };
  }

  doc(path: string) {
    return new MockFirestoreConvertedDocRef(
      new MockFirestoreDocRef(this.firestore, `${this.path}/${path}`),
      this.converter,
    );
  }

  where(field: string, operator: string, value: unknown) {
    return new MockFirestoreConvertedCollectionRef(
      new MockFirestoreFilteredCollectionRef(this.ref, field, operator, value),
      this.converter,
    );
  }

  limit(limit: number) {
    return new MockFirestoreConvertedCollectionRef(
      new MockFirestoreLimitedCollectionRef(this.ref, limit),
      this.converter,
    );
  }
}

class MockFirestoreFilteredCollectionRef extends MockFirestoreCollectionRef {
  readonly ref: MockFirestoreCollectionRef;
  readonly field: string;
  readonly operator: string;
  readonly value: unknown;

  constructor(
    ref: MockFirestoreCollectionRef,
    field: string,
    operator: string,
    value: unknown,
  ) {
    super(ref.firestore, ref.path);
    this.ref = ref;
    this.field = field;
    this.operator = operator;
    this.value = value;
  }

  get() {
    const docs = this.ref.get().docs.filter((doc) => {
      const value = (doc.data() as Record<string, unknown>)[this.field];
      switch (this.operator) {
        case "==":
          return value === this.value;
        case "<":
          return typeof value === "number" && typeof this.value === "number" ?
              value < this.value
            : false;
        case "<=":
          return typeof value === "number" && typeof this.value === "number" ?
              value <= this.value
            : false;
        case ">":
          return typeof value === "number" && typeof this.value === "number" ?
              value > this.value
            : false;
        case ">=":
          return typeof value === "number" && typeof this.value === "number" ?
              value >= this.value
            : false;
        default:
          throw new Error("Unsupported operator");
      }
    });

    return {
      docs: docs,
      ref: this as unknown as MockFirestoreFilteredCollectionRef,
      size: docs.length,
    };
  }
}

class MockFirestoreLimitedCollectionRef extends MockFirestoreCollectionRef {
  readonly ref: MockFirestoreCollectionRef;
  readonly _limit: number;

  constructor(ref: MockFirestoreCollectionRef, limit: number) {
    super(ref.firestore, ref.path);
    this.ref = ref;
    this._limit = limit;
  }

  get() {
    const docs = this.ref.get().docs.slice(0, this._limit);

    return {
      docs: docs,
      ref: this as unknown as MockFirestoreLimitedCollectionRef,
      size: docs.length,
    };
  }
}

class MockFirestoreDocRef extends MockFirestoreRef {
  get() {
    const pathComponents = this.path.split("/");
    const collectionPath = pathComponents.slice(0, -1).join("/");
    const result = this.firestore.collections
      .get(collectionPath)
      ?.get(pathComponents[pathComponents.length - 1]);
    return {
      exists: result !== undefined,
      id: pathComponents[pathComponents.length - 1],
      ref: this as unknown as MockFirestoreDocRef,
      updateTime: Timestamp.now(),
      data: () => result,
    };
  }

  create(data: unknown): void {
    const pathComponents = this.path.split("/");
    const collectionPath = pathComponents.slice(0, -1).join("/");
    if (this.firestore.collections.get(collectionPath) === undefined) {
      this.firestore.collections.set(collectionPath, new Map());
    }
    if (
      this.firestore.collections
        .get(collectionPath)
        ?.get(pathComponents[pathComponents.length - 1]) !== undefined
    ) {
      throw new Error("Document already exists");
    }
    this.firestore.collections
      .get(collectionPath)
      ?.set(pathComponents[pathComponents.length - 1], data);
  }

  listCollections(): string[] {
    const prefix = this.path + "/";
    const result: string[] = [];
    this.firestore.collections.forEach((_, key) => {
      if (!key.startsWith(prefix)) return;
      const collectionName = key.slice(prefix.length);
      if (collectionName.includes("/")) return;
      result.push(collectionName);
    });
    return result;
  }

  set(data: unknown): void {
    const pathComponents = this.path.split("/");
    const collectionPath = pathComponents.slice(0, -1).join("/");
    if (this.firestore.collections.get(collectionPath) === undefined) {
      this.firestore.collections.set(collectionPath, new Map());
    }
    this.firestore.collections
      .get(collectionPath)
      ?.set(pathComponents[pathComponents.length - 1], data);
  }

  update(data: Record<string, unknown>): void {
    const value =
      (this.get().data() as Record<string, unknown> | undefined) ?? {};
    const mergedData = { ...value, ...data };
    this.set(mergedData);
  }

  delete() {
    const pathComponents = this.path.split("/");
    const collectionPath = pathComponents.slice(0, -1).join("/");
    this.firestore.collections
      .get(collectionPath)
      ?.delete(pathComponents[pathComponents.length - 1]);
  }

  withConverter<T>(converter: FirestoreDataConverter<T>) {
    return new MockFirestoreConvertedDocRef(
      this,
      converter,
    ) as unknown as MockFirestoreDocRef;
  }
}

class MockFirestoreCollectionGroupRef extends MockFirestoreCollectionRef {
  private readonly collectionId: string;

  constructor(firestore: MockFirestore, collectionId: string) {
    super(firestore, collectionId);
    this.collectionId = collectionId;
  }

  get() {
    const docs: Array<{
      id: string;
      exists: boolean;
      ref: MockFirestoreDocRef;
      updateTime: Timestamp;
      data: () => unknown;
    }> = [];

    // Find all collections that end with this collectionId
    this.firestore.collections.forEach((docMap, collectionPath) => {
      const pathSegments = collectionPath.split("/");
      const lastSegment = pathSegments[pathSegments.length - 1];

      if (lastSegment === this.collectionId) {
        // This is a matching collection
        docMap.forEach((docData, docId) => {
          docs.push({
            id: docId,
            exists: true,
            ref: new MockFirestoreDocRef(
              this.firestore,
              `${collectionPath}/${docId}`,
            ),
            updateTime: Timestamp.now(),
            data: () => docData,
          });
        });
      }
    });

    return {
      docs: docs,
      ref: this as unknown as MockFirestoreCollectionGroupRef,
      size: docs.length,
    };
  }

  withConverter<T>(
    converter: FirestoreDataConverter<T>,
  ): MockFirestoreCollectionRef {
    return new MockFirestoreConvertedCollectionRef(this, converter);
  }
}

class MockFirestoreConvertedDocRef<T> extends MockFirestoreDocRef {
  readonly ref: MockFirestoreDocRef;
  readonly converter: FirestoreDataConverter<T>;

  constructor(ref: MockFirestoreDocRef, converter: FirestoreDataConverter<T>) {
    super(ref.firestore, ref.path);
    this.ref = ref;
    this.converter = converter;
  }

  get() {
    const result = super.get();
    const data = result.data();
    const clone = {
      exists: result.exists,
      id: result.id,
      ref: result.ref,
      updateTime: result.updateTime,
      data: () => data,
    };
    result.data = () =>
      this.converter.fromFirestore(clone as unknown as QueryDocumentSnapshot);
    return result;
  }

  create(data: T) {
    super.create(this.converter.toFirestore(data));
  }

  set(data: T) {
    super.set(this.converter.toFirestore(data));
  }

  update(data: Record<string, unknown>) {
    const value =
      (this.get().data() as Record<string, unknown> | undefined) ?? {};
    const mergedData = { ...value, ...data };
    this.set(mergedData as T);
  }
}
