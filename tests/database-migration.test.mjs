import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "../server/node_modules/better-sqlite3/lib/index.js";
import { createDatabase } from "../server/src/db/database.mjs";

test("startup migration preserves legacy indexed rows and completed history", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-legacy-db-"));
  const filename = path.join(directory, "legacy.db");
  const legacy = new Database(filename);
  legacy.exec(`
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id TEXT NOT NULL, root TEXT NOT NULL,
      path TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      created_at TEXT NOT NULL, modified_at TEXT NOT NULL
    );
    CREATE TABLE scan_runs (
      scan_id TEXT PRIMARY KEY, root TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT, item_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE staged_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scan_id TEXT NOT NULL, root TEXT NOT NULL,
      path TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
      created_at TEXT NOT NULL, modified_at TEXT NOT NULL
    );
  `);
  legacy.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("completed-old", "C:\\fixture", "C:\\fixture\\keep.txt", "keep.txt", "file", 37, "created", "modified");
  legacy.prepare("INSERT INTO scan_runs (scan_id, root, status, started_at, completed_at, item_count) VALUES (?, ?, ?, ?, ?, ?)")
    .run("completed-old", "C:\\fixture", "completed", "2025-01-01", "2025-01-02", 1);
  legacy.prepare("INSERT INTO scan_runs (scan_id, root, status, started_at, completed_at, item_count) VALUES (?, ?, ?, ?, ?, ?)")
    .run("stale-run", "C:\\fixture", "running", "2025-01-03", null, 0);
  legacy.prepare("INSERT INTO staged_items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("stale-run", "C:\\fixture", "C:\\fixture\\partial.txt", "partial.txt", "file", 10, "", "");
  legacy.close();

  const migrated = createDatabase(filename);
  t.after(async () => { migrated.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const item = migrated.prepare("SELECT id, scan_id, root, path, name, size, access_status FROM items").get();
  assert.deepEqual(item, {
    id: 1, scan_id: "completed-old", root: "C:\\fixture", path: "C:\\fixture\\keep.txt",
    name: "keep.txt", size: 37, access_status: "accessible",
  });
  assert.equal(migrated.prepare("SELECT status FROM scan_runs WHERE scan_id = 'completed-old'").get().status, "completed");
  assert.equal(migrated.prepare("SELECT status FROM scan_runs WHERE scan_id = 'stale-run'").get().status, "interrupted");
  assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM staged_items").get().count, 0);
  const columns = new Set(migrated.pragma("table_info(scan_runs)").map((column) => column.name));
  for (const name of ["indexed_bytes", "added_count", "changed_count", "unchanged_count", "removed_count", "preserved_count", "progress_updated_at", "root_fingerprint", "fingerprint_matches_previous"]) {
    assert.ok(columns.has(name), `${name} is added by the compatible migration`);
  }
});
