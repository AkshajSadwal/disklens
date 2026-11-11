import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";
import { registerScanRoutes } from "../server/src/routes/scans.mjs";

test("scan history is paginated, newest first, and filterable by root", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-scan-history-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const insert = db.prepare("INSERT INTO scan_runs (scan_id, root, status, started_at, completed_at, item_count, indexed_bytes, scanned_count, uploaded_count, skipped_count, added_count, changed_count, unchanged_count, removed_count, preserved_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("old", "/fixture/a", "completed", "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z", 12, 800, 12, 12, 0, 2, 3, 7, 1, 0);
  insert.run("new", "/fixture/a", "aborted", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:20.000Z", 0, 0, 4, 4, 0, 0, 0, 0, 0, 0);
  insert.run("other", "/fixture/b", "failed", "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:01.000Z", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const handlers = new Map();
  const app = {
    get: (route, handler) => handlers.set(route, handler),
    post: () => {},
    addHook: () => {},
    log: { warn() {}, error() {}, info() {} },
  };
  registerScanRoutes(app, db);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });

  const invoke = async (query) => {
    const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
    const payload = await handlers.get("/api/scans/history")({ query }, reply);
    return { statusCode: reply.statusCode, body: reply.payload || payload };
  };
  const all = await invoke({ limit: "2" });
  assert.equal(all.statusCode, 200);
  assert.deepEqual(all.body.runs.map((run) => run.scanId), ["other", "new"]);
  assert.equal(all.body.runs[1].scannedCount, 4);
  assert.equal(all.body.runs[1].indexedBytes, 0);
  const filtered = await invoke({ root: "/fixture/a", limit: "10" });
  assert.deepEqual(filtered.body.runs.map((run) => run.scanId), ["new", "old"]);
  assert.equal(filtered.body.runs[1].indexedBytes, 800);
  assert.deepEqual({ added: filtered.body.runs[1].addedCount, changed: filtered.body.runs[1].changedCount,
    unchanged: filtered.body.runs[1].unchangedCount, removed: filtered.body.runs[1].removedCount,
    preserved: filtered.body.runs[1].preservedCount }, { added: 2, changed: 3, unchanged: 7, removed: 1, preserved: 0 });
  assert.equal((await invoke({ limit: "all" })).statusCode, 400);
});


test("scan history uses insertion order to break equal start-time ties", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-scan-history-order-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const timestamp = "2026-11-11T00:00:00.000Z";
  const insert = db.prepare("INSERT INTO scan_runs (scan_id, root, status, started_at, completed_at) VALUES (?, ?, 'completed', ?, ?)");
  insert.run("z-older", "/fixture/a", timestamp, timestamp);
  insert.run("a-newer", "/fixture/a", timestamp, timestamp);
  const handlers = new Map();
  registerScanRoutes({ get: (route, handler) => handlers.set(route, handler), post: () => {}, addHook: () => {}, log: { info() {}, warn() {}, error() {} } }, db);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });

  const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  const result = await handlers.get("/api/scans/history")({ query: { root: "/fixture/a", limit: "5" } }, reply);
  const body = reply.payload || result;
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(body.runs.map((run) => run.scanId), ["a-newer", "z-older"],
    "the later inserted run must stay first even when its identifier sorts earlier");
});
