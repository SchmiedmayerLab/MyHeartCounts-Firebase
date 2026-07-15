// This source file is part of the MyHeart Counts project
//
// SPDX-FileCopyrightText: 2026 Stanford University and the project authors (see CONTRIBUTORS.md)
// SPDX-License-Identifier: MIT

// One-shot maintenance script. Drains backlog of unprocessed live-health-sample
// uploads from Cloud Storage into Firestore, then deletes the processed source
// files. Intended for use after the `onArchivedLiveHealthSampleUploaded` trigger
// has been temporarily disabled — Storage finalize triggers do not fire
// retroactively, so accumulated files must be processed by this script before
// re-enabling the trigger.
//
// Default mode is DRY-RUN (lists files only). Pass --apply to actually process.
//
// Usage:
//   npm run build
//   GCLOUD_PROJECT=<project-id> \
//     node lib/scripts/backfillArchivedLiveHealthSamples.js \
//     [--bucket=<name>] \
//     [--user=<uid>] \
//     [--concurrency=N] \
//     [--apply]
//
// Credentials: Application Default Credentials. Either set
// GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json or run
// `gcloud auth application-default login` first.

import admin from "firebase-admin";
import { processArchivedLiveHealthSampleObject } from "../functions/onArchivedLiveHealthSampleUploaded.js";

interface Options {
  bucket: string | null;
  user: string | null;
  concurrency: number;
  apply: boolean;
}

const parseArgs = (argv: string[]): Options => {
  const opts: Options = {
    bucket: null,
    user: null,
    concurrency: 5,
    apply: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--apply") {
      opts.apply = true;
    } else if (arg.startsWith("--bucket=")) {
      opts.bucket = arg.slice("--bucket=".length);
    } else if (arg.startsWith("--user=")) {
      opts.user = arg.slice("--user=".length);
    } else if (arg.startsWith("--concurrency=")) {
      const v = Number(arg.slice("--concurrency=".length));
      if (!Number.isInteger(v) || v < 1 || v > 50) {
        throw new Error(`--concurrency must be an integer in [1, 50]`);
      }
      opts.concurrency = v;
    } else {
      throw new Error(`Unknown argument: '${arg}'`);
    }
  }

  return opts;
};

// List user folders under `users/` using the delimiter so we don't scan all
// objects when --user is not specified. Returns the user IDs (folder names).
const listUserIds = async (
  bucket: ReturnType<admin.storage.Storage["bucket"]>,
): Promise<string[]> => {
  const userIds: string[] = [];
  let pageToken: string | undefined = undefined;

  for (;;) {
    const result: unknown[] = await bucket.getFiles({
      prefix: "users/",
      delimiter: "/",
      autoPaginate: false,
      pageToken,
    });
    const apiResponse = result[2] as
      | { prefixes?: string[]; nextPageToken?: string }
      | undefined;

    const prefixes: string[] = apiResponse?.prefixes ?? [];
    for (const p of prefixes) {
      // p looks like "users/<uid>/"
      const parts = p.split("/");
      const uid = parts[1];
      if (uid && uid !== "") userIds.push(uid);
    }

    const next: string | undefined = apiResponse?.nextPageToken;
    if (next === undefined || next === "") break;
    pageToken = next;
  }

  return userIds;
};

const listLiveHealthSampleFiles = async (
  bucket: ReturnType<admin.storage.Storage["bucket"]>,
  userId: string,
): Promise<string[]> => {
  const [files] = await bucket.getFiles({
    prefix: `users/${userId}/liveHealthSamples/`,
  });
  return files.map((f) => f.name);
};

const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const runners: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i++) {
    runners.push(
      (async () => {
        for (;;) {
          const idx = cursor++;
          if (idx >= items.length) return;
          await worker(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(runners);
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv);

  const projectId =
    process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
  if (projectId === undefined || projectId === "") {
    console.error(
      "GCLOUD_PROJECT (or GOOGLE_CLOUD_PROJECT) must be set so we don't accidentally run against the wrong Firebase project.",
    );
    process.exit(1);
  }

  admin.initializeApp();
  // Match the runtime trigger's behavior — see index.ts.
  admin.firestore().settings({ ignoreUndefinedProperties: true });

  const bucket =
    opts.bucket !== null ?
      admin.storage().bucket(opts.bucket)
    : admin.storage().bucket();

  console.log(`Project:     ${projectId}`);
  console.log(`Bucket:      ${bucket.name}`);
  console.log(
    `Mode:        ${opts.apply ? "APPLY (will write Firestore + delete source files)" : "DRY-RUN (list only)"}`,
  );
  console.log(`User scope:  ${opts.user ?? "(all users)"}`);
  console.log(`Concurrency: ${opts.concurrency}`);
  console.log("");

  const userIds: string[] =
    opts.user !== null ? [opts.user] : await listUserIds(bucket);
  console.log(`Found ${userIds.length} user folder(s) to scan.`);

  let totalFiles = 0;
  let totalProcessed = 0;
  let totalErrored = 0;
  const startedAt = Date.now();

  for (const userId of userIds) {
    const fileNames = await listLiveHealthSampleFiles(bucket, userId);
    if (fileNames.length === 0) continue;
    totalFiles += fileNames.length;
    console.log(`[${userId}] ${fileNames.length} file(s)`);

    if (!opts.apply) continue;

    await runWithConcurrency(fileNames, opts.concurrency, async (filePath) => {
      try {
        await processArchivedLiveHealthSampleObject(bucket.name, filePath);
        totalProcessed++;
      } catch (err) {
        totalErrored++;
        console.error(`[${userId}] failed ${filePath}:`, err);
      }
    });
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`Total files matched:  ${totalFiles}`);
  if (opts.apply) {
    console.log(`Total processed:      ${totalProcessed}`);
    console.log(`Total errored:        ${totalErrored}`);
  } else {
    console.log(`Dry-run: pass --apply to process.`);
  }
  console.log(`Elapsed:              ${elapsedSec}s`);
};

main().catch((err: unknown) => {
  console.error("Backfill script failed:", err);
  process.exit(1);
});
