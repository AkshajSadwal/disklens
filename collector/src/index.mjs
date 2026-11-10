import path from "node:path";

import { SERVER } from "./config.mjs";
import { getDriveMetadata } from "./driveMetadata.mjs";
import { scanRoot } from "./scanner.mjs";
import { uploadDriveMetadata } from "./uploader.mjs";

const ROOTS = process.argv.slice(2);

if (ROOTS.length === 0) {
  console.error('Usage: node src/index.mjs "A:\\" "B:\\" "C:\\"');
  process.exit(1);
}

const controller = new AbortController();
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  controller.abort();
  console.log("\\nCancellation requested. Flushing the current upload batch...");
});

const startedAt = Date.now();
const stats = {
  totalItems: 0,
  uploadedItems: 0,
  skippedItems: 0,
  onProgress({ root, scanned, uploaded, skipped }) {
    if (scanned % 1000 === 0) {
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
      const rate = Math.round(scanned / elapsedSeconds);
      console.log(`${root}: ${scanned.toLocaleString()} entries scanned | ${uploaded.toLocaleString()} uploaded | ${skipped.toLocaleString()} skipped | ${rate.toLocaleString()}/sec`);
    }
  },
};

for (const inputRoot of ROOTS) {
  const root = path.resolve(inputRoot);

  try {
    const drive = await getDriveMetadata(root);

    console.log(`${drive.root} → ${drive.volumeName || "Local Disk"}`);
    console.log(`Capacity: ${drive.totalBytes} bytes`);
    console.log(`Free: ${drive.freeBytes} bytes`);
    console.log(`Used: ${drive.usedBytes} bytes`);
    console.log(`Filesystem: ${drive.fileSystem}`);

    try {
      await uploadDriveMetadata({ server: SERVER, drive });
    } catch (uploadError) {
      console.warn(`Could not upload drive metadata for ${root}:`, uploadError.message);
    }
  } catch (error) {
    console.warn(
      `Could not read drive metadata for ${root}:`,
      error.message,
    );
  }

  await scanRoot({ root, server: SERVER, stats, signal: controller.signal });
  if (interrupted) break;
}

console.log("");
console.log("Scan complete.");
console.log(`Items collected: ${stats.totalItems}`);
console.log(`Items uploaded: ${stats.uploadedItems}`);
console.log(`Items skipped or partially inaccessible: ${stats.skippedItems}`);
console.log(`Elapsed: ${Math.round((Date.now() - startedAt) / 1000)} seconds`);
if (interrupted) process.exitCode = 130;
