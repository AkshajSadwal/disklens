import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { getDriveMetadata, windowsDriveRoot } from "../collector/src/driveMetadata.mjs";

test("Windows drive metadata resolves nested paths to local drive roots and leaves UNC shares to statfs", () => {
  assert.equal(windowsDriveRoot("C:\\"), "C:\\");
  assert.equal(windowsDriveRoot("c:\\Users\\Akshaj\\Documents"), "c:\\");
  assert.equal(windowsDriveRoot("\\\\server\\share\\folder"), null);
  assert.equal(windowsDriveRoot("\\\\server\\share\\"), null);
});

test("drive capacity metadata remains available from statfs when optional platform labels fail", async () => {
  const metadata = await getDriveMetadata(os.tmpdir());
  assert.ok(metadata.root);
  assert.ok(Number(metadata.totalBytes) > 0);
  assert.ok(Number(metadata.freeBytes) >= 0);
  assert.ok(Number(metadata.freeBytes) <= Number(metadata.totalBytes));
  assert.ok(metadata.fileSystem);
});
