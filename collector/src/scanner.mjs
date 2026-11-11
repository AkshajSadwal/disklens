import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { BATCH_SIZE } from "./config.mjs";
import { DirectoryStack } from "./directoryStack.mjs";
import { abortScan, completeScan, startScan, updateScanItemAccess, updateScanProgress, uploadScanBatch } from "./uploader.mjs";

const ENTRY_METADATA_BATCH_SIZE = 16;

const PRIVATE_DIRECTORY_NAMES = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", "credentials", "credential", "gcloud",
  "gh", "vault", "protect", "1password", "bitwarden", "keepass",
]);
const PRIVATE_FILE_NAMES = new Set([
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials", "credentials.json",
  "token.json", "secrets.json", "authorized_keys", "known_hosts", "id_rsa", "id_dsa",
  "id_ecdsa", "id_ed25519", "logins.json", "key4.db", "cert9.db", "cookies",
  "login data", "login data-journal", "web data", "web data-journal", "local state",
  "cookies-journal", "cookies.sqlite", "key4.db", "cert9.db",
]);
const PRIVATE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".ppk", ".kdbx", ".ovpn"]);

export function isPrivacyExcluded(name, isDirectory = false) {
  const lower = String(name || "").toLowerCase();
  if (isDirectory) return PRIVATE_DIRECTORY_NAMES.has(lower);
  return PRIVATE_FILE_NAMES.has(lower) || lower === ".env" || lower.startsWith(".env.") ||
    /^id_(rsa|dsa|ecdsa|ed25519)(?:[_-].*)?(?:\.pub)?$/.test(lower) ||
    PRIVATE_EXTENSIONS.has(path.extname(lower));
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
}

/** Counts entries that can be enumerated without following symbolic links. */
export async function countRootEntries({ root, signal, onProgress, directoryQueueLimit = 1024 }) {
  const queue = new DirectoryStack({ maxInMemory: directoryQueueLimit });
  let count = 0;
  let visitedDirectories = 0;
  try {
    await queue.push(root);
    while (true) {
      throwIfAborted(signal);
      const directory = await queue.pop();
      if (directory === undefined) break;
      let handle;
      try {
        // Recheck queued paths immediately before opening them: an entry can
        // be replaced with a symlink or another file after its parent pass.
        const directoryStat = await fs.lstat(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
          const error = new Error("Queued directory changed type before traversal.");
          error.code = directoryStat.isSymbolicLink() ? "SYMLINK_REPLACED" : "NOT_A_DIRECTORY";
          throw error;
        }
        handle = await fs.opendir(directory, { bufferSize: 32 });
      } catch (error) {
        if (directory === root) throw new Error(`Cannot read the selected scan folder: ${root} (${error.code || error.message})`);
        continue;
      }
      visitedDirectories += 1;
      try {
        for await (const entry of handle) {
          if (isPrivacyExcluded(entry.name, entry.isDirectory())) continue;
          count += 1;
          if (entry.isDirectory() && !entry.isSymbolicLink()) await queue.push(path.join(directory, entry.name));
        }
      } finally {
        await handle.close().catch(() => {});
      }
      if (visitedDirectories % 25 === 0) onProgress?.({ directories: visitedDirectories, counted: count });
    }
    onProgress?.({ directories: visitedDirectories, counted: count });
    return count;
  } finally {
    await queue.close();
  }
}

export async function scanRoot({ root, server, stats, signal, directoryQueueLimit = 1024, lstat = fs.lstat }) {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Scan target cannot be a symbolic link: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Scan target must be a directory: ${root}`);
  throwIfAborted(signal);

  const scanId = crypto.randomUUID();
  const started = await startScan({ server, root, scanId, signal });
  const previousItemCount = Math.max(0, Math.floor(Number(started?.previousItemCount) || 0));
  const usePreviousEstimate = previousItemCount > 0;

  let totalEntries = usePreviousEstimate ? previousItemCount : 0;
  let batch = [];
  let scanned = 0;
  let uploaded = 0;
  let skipped = 0;
  const startedAt = Date.now();
  const queue = new DirectoryStack({ maxInMemory: directoryQueueLimit });
  let lastProgressSync = 0;

  async function flush() {
    if (!batch.length) return;
    const sending = batch;
    await uploadScanBatch({ server, root, scanId, items: sending, signal });
    uploaded += sending.length;
    batch = [];
    stats.uploadedItems += sending.length;
    await updateScanProgress({ server, root, scanId, scanned, uploaded, skipped, total: totalEntries, signal });
  }

  try {
    await queue.push(root);
    if (usePreviousEstimate) {
      console.log(`Using the previous scan count as an estimate for ${root}...`);
    } else {
      console.log(`Estimating scan size for ${root}...`);
      totalEntries = await countRootEntries({
        root,
        signal,
        directoryQueueLimit,
        onProgress: ({ directories, counted }) => stats.onEstimate?.({ root, directories, counted }),
      });
    }
    throwIfAborted(signal);
    await updateScanProgress({ server, root, scanId, scanned: 0, uploaded: 0, skipped: 0, total: totalEntries, signal });

    while (true) {
      throwIfAborted(signal);
      const directory = await queue.pop();
      if (directory === undefined) break;
      let handle;
      try {
        handle = await fs.opendir(directory, { bufferSize: 32 });
      } catch (error) {
        if (directory === root) {
          // If the selected root can no longer be read, do not mistake this for
          // a successful empty scan and replace the previous index.
          throw new Error(`Cannot read the selected scan folder: ${root} (${error.code || error.message})`);
        }
        // A child directory may become inaccessible between the estimate and
        // scan passes. Its parent row remains staged, while descendants are skipped.
        stats.runtimeAccessErrors = (stats.runtimeAccessErrors || 0) + 1;
        await flush();
        skipped += 1;
        await updateScanItemAccess({ server, root, scanId, itemPath: directory, accessStatus: "denied", errorCode: error.code || "ACCESS_DENIED", signal });
        await updateScanProgress({ server, root, scanId, scanned, uploaded, skipped, total: totalEntries, signal });
        continue;
      }

      try {
      let entryBuffer = [];
      const processEntryBuffer = async () => {
        const entries = entryBuffer;
        entryBuffer = [];
        const metadata = await Promise.all(entries.map(async (entry) => {
          if (isPrivacyExcluded(entry.name, entry.isDirectory())) return { entry, excluded: true };
          const fullPath = path.join(directory, entry.name);
          try {
            return { entry, fullPath, stat: await lstat(fullPath) };
          } catch (error) {
            return { entry, fullPath, stat: null, errorCode: error.code || "UNKNOWN_ERROR" };
          }
        }));

        // Metadata reads overlap within a fixed-size window. Apply results in
        // directory order so queue ordering, progress, and upload batches stay deterministic.
        for (const result of metadata) {
          throwIfAborted(signal);
          const { entry } = result;
          if (result.excluded) {
            stats.privacyExcludedItems = (stats.privacyExcludedItems || 0) + 1;
            continue;
          }
          const fullPath = result.fullPath;
          const stat = result.stat;
          const direntType = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symbolic-link" : "other";
          const itemType = stat?.isSymbolicLink() ? "symbolic-link" : stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : direntType;
          const accessStatus = stat ? "accessible" : "metadata-unavailable";
          const errorCode = result.errorCode || null;
          batch.push({
            path: fullPath,
            name: entry.name,
            type: itemType,
            size: Number(stat?.size) || 0,
            createdAt: stat?.birthtime?.toISOString?.() || "",
            modifiedAt: stat?.mtime?.toISOString?.() || "",
            accessStatus,
            errorCode,
          });
          scanned += 1;
          if (usePreviousEstimate && scanned >= totalEntries) {
            // Keep the provisional percentage below 100% until traversal really
            // ends; if the tree grew, extend the estimate in coarse increments.
            totalEntries = scanned + Math.max(100, Math.ceil(totalEntries * 0.1));
          }
          if (accessStatus !== "accessible") skipped += 1;
          if (itemType === "directory" && accessStatus === "accessible") await queue.push(fullPath);
          if (batch.length >= BATCH_SIZE) await flush();
          if (scanned % 25 === 0 || scanned === totalEntries) {
            stats.onProgress?.({ root, scanned, total: totalEntries, uploaded, skipped, elapsedMs: Date.now() - startedAt });
          }
          // Publish frequent count updates so the UI progress bar moves smoothly,
          // including while a batch is still being assembled.
          if (scanned - lastProgressSync >= 75 || scanned === totalEntries) {
            await updateScanProgress({ server, root, scanId, scanned, uploaded, skipped, total: totalEntries, signal });
            lastProgressSync = scanned;
          }
        }
      };
      for await (const entry of handle) {
        throwIfAborted(signal);
        entryBuffer.push(entry);
        if (entryBuffer.length >= ENTRY_METADATA_BATCH_SIZE) await processEntryBuffer();
      }
      if (entryBuffer.length) await processEntryBuffer();
      } finally {
        await handle.close().catch(() => {});
      }
    }

    throwIfAborted(signal);
    if (usePreviousEstimate && totalEntries !== scanned) totalEntries = scanned;
    await flush();
    await updateScanProgress({ server, root, scanId, scanned, uploaded, skipped, total: totalEntries, signal });
    const result = await completeScan({ server, root, scanId, signal });
    stats.totalItems += scanned;
    stats.skippedItems += skipped;
    console.log(`Finished ${root}: ${scanned.toLocaleString()} entries indexed.`);
    return { ...result, scanned, uploaded, skipped, totalEntries };
  } catch (error) {
    await abortScan({ server, root, scanId }).catch((abortError) => {
      console.warn(`Could not clean up interrupted scan ${scanId}: ${abortError.message}`);
    });
    throw error;
  } finally {
    await queue.close();
  }
}
