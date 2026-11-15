// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

import { createHash, randomUUID } from "crypto";
import { type Bucket } from "@google-cloud/storage";
import { compress } from "@mongodb-js/zstd";
import { type BuiltBundle } from "./bundleBuilder.js";
import { type RecordingRecordDraft } from "./drafts.js";
import { period } from "./time.js";
import { type HealthProviderId } from "../../../models/index.js";
import { type ProviderRawArchive } from "../healthProviderAdapter.js";

/** File-name-safe form of a source-type token (`getmeas:9+10` → `getmeas-9-10`). */
export const sourceTypeFileToken = (sourceType: string): string =>
  sourceType.replace(/[^A-Za-z0-9_-]+/g, "-");

/**
 * 24 hex characters of SHA-256 over the sorted Provenance fullUrls joined by
 * `\n` — the same content-addressed naming the iOS uploader uses, so an exact
 * retry of the same record versions overwrites rather than duplicates.
 */
export const bundleContentHash = (provenanceFullUrls: string[]): string =>
  createHash("sha256")
    .update([...provenanceFullUrls].sort().join("\n"), "utf8")
    .digest("hex")
    .slice(0, 24);

/** `users/{uid}/providerHealthSamples/{provider}/{provider}_{sourceType}_{24hex}.json.zstd` */
export const providerBundleStoragePath = (
  userId: string,
  provider: HealthProviderId,
  bundle: Pick<BuiltBundle, "sourceType" | "provenanceFullUrls">,
): string =>
  `users/${userId}/providerHealthSamples/${provider}/${provider}_${sourceTypeFileToken(bundle.sourceType)}_${bundleContentHash(bundle.provenanceFullUrls)}.json.zstd`;

/** Compress and upload every bundle. Throws on the first failure. */
export const uploadProviderBundles = async (params: {
  bucket: Bucket;
  userId: string;
  provider: HealthProviderId;
  bundles: BuiltBundle[];
}): Promise<string[]> => {
  const paths: string[] = [];
  for (const bundle of params.bundles) {
    const path = providerBundleStoragePath(
      params.userId,
      params.provider,
      bundle,
    );
    const compressed = await compress(
      Buffer.from(JSON.stringify(bundle.bundle), "utf8"),
    );
    await params.bucket.file(path).save(compressed, {
      contentType: "application/octet-stream",
      metadata: {
        metadata: {
          format: "grove-mobile-exchange-bundle",
          groveVersion: "0.8.0",
          compression: "zstd",
          recordCount: String(bundle.recordCount),
        },
      },
    });
    paths.push(path);
  }
  return paths;
};

/** `users/{uid}/{provider}HealthSamples/{provider}_{dataType}_{fileId}.json.zstd` */
export const rawArchiveStoragePath = (
  userId: string,
  provider: HealthProviderId,
  dataType: string,
  fileId: string,
): string =>
  `users/${userId}/${provider}HealthSamples/${provider}_${dataType}_${fileId}.json.zstd`;

/**
 * Compress and upload each raw payload and return a recording draft per
 * archive, which the exchange Bundle describes as a
 * `providers-recording-document` (url, size, hash). The random file id doubles
 * as the persisted opaque import key the provider catalog requires for records
 * without a native id. Throws on the first failure.
 */
export const archiveRawPayloads = async (params: {
  bucket: Bucket;
  userId: string;
  provider: HealthProviderId;
  archives: ProviderRawArchive[];
  since: Date;
  until: Date;
}): Promise<RecordingRecordDraft[]> => {
  const occurred = period(params.since, params.until);
  const drafts: RecordingRecordDraft[] = [];
  for (const archive of params.archives) {
    const payload = Buffer.from(JSON.stringify(archive.payload), "utf8");
    const fileId = randomUUID();
    const path = rawArchiveStoragePath(
      params.userId,
      params.provider,
      archive.dataType,
      fileId,
    );
    await params.bucket
      .file(path)
      .save(await compress(payload), { contentType: "application/zstd" });
    drafts.push({
      kind: "recording",
      sourceType: archive.sourceType,
      nativeRecordId: fileId,
      occurred,
      typeText: archive.typeText,
      payload,
      url: `gs://${params.bucket.name}/${path}`,
    });
  }
  return drafts;
};
