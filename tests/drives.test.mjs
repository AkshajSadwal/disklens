import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";
import { registerDriveRoutes } from "../server/src/routes/drives.mjs";

test("non-Windows drive route returns stored metadata without starting PowerShell", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-drives-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  db.prepare(`INSERT INTO drives (root, volume_name, file_system, total_bytes, free_bytes, used_bytes, updated_at)
    VALUES ('/fixture', 'Fixture volume', 'testfs', 1000, 400, 600, '2026-01-01T00:00:00.000Z')`).run();
  let warnings = 0;
  const handlers = new Map();
  registerDriveRoutes({
    get: (route, handler) => handlers.set(route, handler),
    post: () => {},
  }, db, { platform: "linux" });
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });

  const rows = await handlers.get("/api/drives")({ log: { warn() { warnings += 1; } } });
  assert.equal(warnings, 0);
  assert.equal(rows.length, 1);
  assert.deepEqual({ root: rows[0].root, totalBytes: rows[0].totalBytes }, { root: "/fixture", totalBytes: 1000 });
});
