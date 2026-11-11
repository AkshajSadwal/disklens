import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { BATCH_SIZE } from "./config.mjs";
import { abortScan, completeScan, startScan, updateScanProgress, uploadScanBatch } from "./uploader.mjs";

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

async function listEntries(directory) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** Counts entries that can be enumerated without following symbolic links. */
export async function countRootEntries({ root, signal, onProgress }) {
  const firstEntries = await listEntries(root);
  if (!firstEntries) throw new Error(`Cannot read the selected scan folder: ${root}`);
  const queue = [{ directory: root, entries: firstEntries }];
  let count = 0;
  let visitedDirectories = 0;
  while (queue.length) {
    throwIfAborted(signal);
    const current = queue.pop();
    const directory = current.directory;
    const entries = current.entries ?? await listEntries(directory);
    visitedDirectories += 1;
    if (entries) {
      for (const entry of entries) {
        if (isPrivacyExcluded(entry.name, entry.isDirectory())) continue;
        count += 1;
        if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ directory: path.join(directory, entry.name), entries: null });
      }
    }
    if (visitedDirectories % 25 === 0) onProgress?.({ directories: visitedDirectories, counted: count });
  }
  onProgress?.({ directories: visitedDirectories, counted: count });
  return count;
}

export async function scanRoot({ root, server, stats, signal }) {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error(`Scan target cannot be a symbolic link: ${root}`);
  if (!rootStat.isDirectory()) throw new Error(`Scan target must be a directory: ${root}`);
  throwIfAborted(signal);

  const scanId = crypto.randomUUID();
  await startScan({ server, root, scanId, signal });

  let totalEntries = 0;
  let batch = [];
  let scanned = 0;
  let uploaded = 0;
  let skipped = 0;
  const startedAt = Date.now();
  const queue = [root];

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
    console.log(`Estimating scan size for ${root}...`);
    totalEntries = await countRootEntries({
      root,
      signal,
      onProgress: ({ directories, counted }) => stats.onEstimate?.({ root, directories, counted }),
    });
    throwIfAborted(signal);
    await updateScanProgress({ server, root, scanId, scanned: 0, uploaded: 0, skipped: 0, total: totalEntries, signal });

    while (queue.length) {
      throwIfAborted(signal);
      const directory = queue.pop();
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (directory === root) {
          // If the selected root can no longer be read, do not mistake this for
          // a successful empty scan and replace the previous index.
          throw new Error(`Cannot read the selected scan folder: ${root} (${error.code || error.message})`);
        }
        // A child directory may become inaccessible between the estimate and
        // scan passes. Its parent row remains staged, while descendants are skipped.
        stats.runtimeAccessErrors = (stats.runtimeAccessErrors || 0) + 1;
        continue;
      }

      for (const entry of entries) {
        throwIfAborted(signal);
        if (isPrivacyExcluded(entry.name, entry.isDirectory())) {
          stats.privacyExcludedItems = (stats.privacyExcludedItems || 0) + 1;
          continue;
        }
        const fullPath = path.join(directory, entry.name);
        const isDirectory = entry.isDirectory();
        const isFile = entry.isFile();
        const isLink = entry.isSymbolicLink();
        let stat = null;
        let accessStatus = "accessible";
        let errorCode = null;
        try {
          stat = await fs.lstat(fullPath);
        } catch (error) {
          accessStatus = "metadata-unavailable";
          errorCode = error.code || "UNKNOWN_ERROR";
        }
        if (isDirectory && !isLink) {
          try {
            await fs.readdir(fullPath, { withFileTypes: true });
          } catch (error) {
            accessStatus = "denied";
            errorCode = error.code || "ACCESS_DENIED";
          }
        }
        batch.push({
          path: fullPath,
          name: entry.name,
          type: isDirectory ? "directory" : isFile ? "file" : isLink ? "symbolic-link" : "other",
          size: Number(stat?.size) || 0,
          createdAt: stat?.birthtime?.toISOString?.() || "",
          modifiedAt: stat?.mtime?.toISOString?.() || "",
          accessStatus,
          errorCode,
        });
        scanned += 1;
        if (accessStatus !== "accessible") skipped += 1;
        if (isDirectory && !isLink && accessStatus === "accessible") queue.push(fullPath);
        if (batch.length >= BATCH_SIZE) await flush();
        if (scanned % 25 === 0 || scanned === totalEntries) {
          stats.onProgress?.({ root, scanned, total: totalEntries, uploaded, skipped, elapsedMs: Date.now() - startedAt });
        }
      }
    }

    throwIfAborted(signal);
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
  }
}
