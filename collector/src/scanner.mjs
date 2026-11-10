import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { BATCH_SIZE } from "./config.mjs";
import { uploadScanBatch } from "./uploader.mjs";

export async function scanRoot({ root, server, stats, signal }) {
  const scanId = crypto.randomUUID();

  let batch = [];
  let firstBatch = true;

  async function sendBatch() {
    if (batch.length === 0) return;

    const currentBatch = batch;
    batch = [];

    await uploadScanBatch({
      server,
      root,
      scanId,
      replace: firstBatch,
      items: currentBatch,
    });

    stats.uploadedItems += currentBatch.length;
    firstBatch = false;

    if (stats.uploadedItems % 10000 < currentBatch.length) {
      console.log(`Uploaded ${stats.uploadedItems} items...`);
    }
  }

  async function addItem(item) {
    batch.push(item);
    stats.totalItems++;
    stats.skippedItems ??= 0;
    if (item.accessStatus !== "accessible") stats.skippedItems++;
    if (typeof stats.onProgress === "function") {
      stats.onProgress({ root, scanned: stats.totalItems, uploaded: stats.uploadedItems, skipped: stats.skippedItems });
    }

    if (batch.length >= BATCH_SIZE) {
      await sendBatch();
    }
  }

  async function scan(directory) {
    let entries;

    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      console.warn(`Access denied: ${directory}`);
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) return;
      const fullPath = path.join(directory, entry.name);

      let stat = null;
      let metadataError = null;

      try {
        stat = await fs.lstat(fullPath);
      } catch (error) {
        metadataError = error.code || "UNKNOWN_ERROR";
      }

      const isDirectory = entry.isDirectory();
      const isFile = entry.isFile();
      const isLink = entry.isSymbolicLink();

      let accessStatus = "accessible";
      let accessError = null;

      if (isDirectory && !isLink) {
        try {
          await fs.readdir(fullPath, {
            withFileTypes: true,
          });
        } catch (error) {
          accessStatus = "denied";
          accessError = error.code || "UNKNOWN_ERROR";

          console.warn(`Access denied: ${fullPath}`);
        }
      }

      if (metadataError) {
        accessStatus = "metadata-unavailable";
        accessError = metadataError;
      }

      await addItem({
        path: fullPath,
        name: entry.name,

        type: isDirectory
          ? "directory"
          : isFile
            ? "file"
            : isLink
              ? "symbolic-link"
              : "other",

        size: stat ? stat.size : 0,

        createdAt: stat ? stat.birthtime.toISOString() : "",

        modifiedAt: stat ? stat.mtime.toISOString() : "",

        accessStatus,
        errorCode: accessError,
      });

      if (isDirectory && !isLink && accessStatus === "accessible") {
        await scan(fullPath);
      }
    }
  }

  console.log(`Scanning ${root}...`);

  await scan(root);
  // Flush already-collected data even when the user cancels the scan.
  await sendBatch();

  console.log(`${signal?.aborted ? "Stopped" : "Finished"} ${root} — ${scanId}`);
}
