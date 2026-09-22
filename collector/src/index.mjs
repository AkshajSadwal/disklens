import path from "node:path";

import { SERVER } from "./config.mjs";
import { getDriveMetadata } from "./driveMetadata.mjs";
import { scanRoot } from "./scanner.mjs";

const ROOTS = process.argv.slice(2);

if (ROOTS.length === 0) {
  console.error('Usage: node src/index.mjs "A:\\" "B:\\" "C:\\"');
  process.exit(1);
}

const stats = {
  totalItems: 0,
  uploadedItems: 0,
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
  } catch (error) {
    console.warn(
      `Could not read drive metadata for ${root}:`,
      error.message,
    );
  }

  await scanRoot({ root, server: SERVER, stats });
}

console.log("");
console.log("Scan complete.");
console.log(`Items collected: ${stats.totalItems}`);
console.log(`Items uploaded: ${stats.uploadedItems}`);
