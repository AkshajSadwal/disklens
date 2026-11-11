import path from "node:path";

import { SERVER } from "./config.mjs";
import { getDriveMetadata } from "./driveMetadata.mjs";
import { scanRoot } from "./scanner.mjs";
import { uploadDriveMetadata } from "./uploader.mjs";

const roots = process.argv.slice(2).map((value) => value.trim()).filter(Boolean);
if (roots.length === 0) {
  console.error('Usage: node src/index.mjs "C:\\Users\\YourName\\Downloads" ["D:\\"]');
  process.exit(1);
}

const controller = new AbortController();
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  controller.abort();
  if (process.stdout.isTTY) process.stdout.write("\nCancellation requested; preserving the last completed index...\n");
  else console.log("Cancellation requested; preserving the last completed index...");
});

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

const stats = {
  totalItems: 0,
  uploadedItems: 0,
  skippedItems: 0,
  privacyExcludedItems: 0,
  onEstimate({ root, directories, counted }) {
    if (process.stdout.isTTY) {
      process.stdout.write(`\rEstimating ${root}: ${counted.toLocaleString()} entries discovered in ${directories.toLocaleString()} folders`);
    }
  },
  onProgress({ root, scanned, total, uploaded, skipped, elapsedMs }) {
    if (!process.stdout.isTTY) return;
    const percent = total > 0 ? Math.min(100, (scanned / total) * 100) : 100;
    const width = 24;
    const filled = Math.round((percent / 100) * width);
    const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
    const rate = elapsedMs > 0 ? scanned / (elapsedMs / 1000) : 0;
    const remaining = rate > 0 ? Math.max(0, (total - scanned) / rate) : 0;
    const eta = rate > 0 ? formatDuration(remaining) : "estimating";
    const elapsed = formatDuration(elapsedMs / 1000);
    process.stdout.write(`\r${bar} ${percent.toFixed(1).padStart(5)}% | ${scanned.toLocaleString()}/${total.toLocaleString()} | ${uploaded.toLocaleString()} uploaded | ${skipped.toLocaleString()} partial | elapsed ${elapsed} | ETA ${eta}   `);
  },
};

const startedAt = Date.now();
for (const inputRoot of roots) {
  if (interrupted) break;
  const root = path.resolve(inputRoot);
  try {
    const drive = await getDriveMetadata(root);
    console.log(`\n${drive.root} → ${drive.volumeName || "Local Disk"}`);
    console.log(`Capacity: ${drive.totalBytes} bytes | Free: ${drive.freeBytes} bytes | Filesystem: ${drive.fileSystem}`);
    await uploadDriveMetadata({ server: SERVER, drive }).catch((error) => {
      console.warn(`Could not upload drive metadata: ${error.message}`);
    });
  } catch (error) {
    console.warn(`Could not read drive metadata for ${root}: ${error.message}`);
  }

  try {
    await scanRoot({ root, server: SERVER, stats, signal: controller.signal });
    if (process.stdout.isTTY) process.stdout.write("\n");
  } catch (error) {
    if (error?.name === "AbortError" || interrupted) break;
    console.error(`\nScan failed for ${root}: ${error.message}`);
    process.exitCode = 1;
    break;
  }
}

const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
console.log("\nDiskLens scan summary");
console.log(`Items collected: ${stats.totalItems.toLocaleString()}`);
console.log(`Items uploaded: ${stats.uploadedItems.toLocaleString()}`);
console.log(`Items skipped or partially inaccessible: ${stats.skippedItems.toLocaleString()}`);
console.log(`Private credential/config entries excluded: ${stats.privacyExcludedItems.toLocaleString()}`);
console.log(`Elapsed: ${elapsedSeconds} seconds`);
if (interrupted) process.exitCode = 130;
