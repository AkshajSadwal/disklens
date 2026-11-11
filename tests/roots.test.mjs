import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";
import { normalizeRootKey, registerRootRoutes } from "../server/src/routes/roots.mjs";

test("root identities fold case only on Windows and retain POSIX case distinctions", () => {
  assert.equal(normalizeRootKey("C:", "win32"), "C:\\");
  assert.equal(normalizeRootKey("c:\\", "win32"), "C:\\");
  assert.equal(normalizeRootKey("\\\\server\\share\\", "win32"), "\\\\SERVER\\SHARE");
  assert.equal(normalizeRootKey("/home/Akshaj///", "linux"), "/home/Akshaj");
  assert.equal(normalizeRootKey("/home/Akshaj", "darwin"), "/home/Akshaj");
  assert.notEqual(normalizeRootKey("/home/Akshaj", "linux"), normalizeRootKey("/home/akshaj", "linux"));
  assert.equal(normalizeRootKey("/", "linux"), "/");
});

test("root listing keeps distinct case-sensitive POSIX scan roots separate", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-roots-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  db.prepare(`INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at)
    VALUES ('one', '/fixture/A', '/fixture/A/file', 'file', 'file', 3, '', ''),
      ('two', '/fixture/a', '/fixture/a/file', 'file', 'file', 5, '', '')`).run();
  const handlers = new Map();
  registerRootRoutes({ get: (route, handler) => handlers.set(route, handler) }, db, { platform: "linux" });
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });

  const roots = await handlers.get("/api/roots")();
  assert.equal(roots.length, 2);
  assert.deepEqual(roots.map((root) => root.root).sort(), ["/fixture/A", "/fixture/a"]);
  assert.deepEqual(roots.map((root) => root.size).sort((a, b) => a - b), [3, 5]);
});
