// This source file is part of the My Heart Counts Firebase open-source project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { Storage, type Bucket } from "@google-cloud/storage";
import { expect } from "chai";
import { stub, restore, type SinonStub } from "sinon";
import { describeWithEmulators } from "../tests/functions/testEnvironment.js";

describe("function: processUserDeletions", () => {
  let storageStub: SinonStub;
  let getFilesStub: SinonStub;
  let deleteStub: SinonStub;

  beforeEach(() => {
    deleteStub = stub();
    getFilesStub = stub().resolves([
      [{ name: "users/testuser1/file1.jpg", delete: deleteStub }],
    ]);
    const bucketStub = {
      getFiles: getFilesStub,
    };
    storageStub = stub(Storage.prototype, "bucket").returns(
      bucketStub as unknown as Bucket,
    );
    process.env.GCLOUD_PROJECT = "test-project";
  });

  afterEach(() => {
    restore();
    delete process.env.GCLOUD_PROJECT;
    delete process.env.DATA_COLLECTION_BUCKET;
  });

  describeWithEmulators("processUserDeletions integration", (_env) => {
    it("runs without throwing errors", async () => {
      const { processUserDeletions } =
        await import("./processUserDeletions.js");
      await processUserDeletions();
    });
  });

  describe("deleteUserStorageFiles unit tests", () => {
    it("deletes multiple storage files", async () => {
      const mockFiles = [
        { name: "users/testuser/file1.jpg", delete: stub().resolves() },
        { name: "users/testuser/file2.pdf", delete: stub().resolves() },
        { name: "users/testuser/folder/file3.txt", delete: stub().resolves() },
      ];

      getFilesStub.resolves([mockFiles]);

      const { deleteUserStorageFiles } =
        await import("./processUserDeletions.js");

      await deleteUserStorageFiles("testuser");

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(storageStub.calledOnceWith("test-project.appspot.com")).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(getFilesStub.calledOnceWith({ prefix: "users/testuser/" })).to.be
        .true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(mockFiles[0].delete.calledOnce).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(mockFiles[1].delete.calledOnce).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(mockFiles[2].delete.calledOnce).to.be.true;
    });

    it("also deletes files in the data collection bucket", async () => {
      process.env.DATA_COLLECTION_BUCKET = "test-datacollection";
      const mockFile = {
        name: "users/testuser/file.json.zstd",
        delete: stub().resolves(),
      };
      getFilesStub.resolves([[mockFile]]);

      const { deleteUserStorageFiles } =
        await import("./processUserDeletions.js");

      await deleteUserStorageFiles("testuser");

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(storageStub.calledWith("test-project.appspot.com")).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(storageStub.calledWith("test-datacollection")).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(getFilesStub.calledTwice).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(mockFile.delete.calledTwice).to.be.true;
    });

    it("handles empty file list", async () => {
      getFilesStub.resolves([[]]);

      const { deleteUserStorageFiles } =
        await import("./processUserDeletions.js");

      await deleteUserStorageFiles("testuser");

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(storageStub.calledOnce).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(getFilesStub.calledOnce).to.be.true;
    });

    it("throws error when storage operation fails", async () => {
      getFilesStub.rejects(new Error("Storage error"));

      const { deleteUserStorageFiles } =
        await import("./processUserDeletions.js");

      try {
        await deleteUserStorageFiles("testuser");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as Error).message).to.equal("Storage error");
      }
    });

    it("handles file deletion failures", async () => {
      const mockFiles = [
        {
          name: "users/testuser/file1.jpg",
          delete: stub().rejects(new Error("Delete failed")),
        },
        { name: "users/testuser/file2.pdf", delete: stub().resolves() },
      ];

      getFilesStub.resolves([mockFiles]);

      const { deleteUserStorageFiles } =
        await import("./processUserDeletions.js");

      try {
        await deleteUserStorageFiles("testuser");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as Error).message).to.include("Delete failed");
      }
    });
  });
});
