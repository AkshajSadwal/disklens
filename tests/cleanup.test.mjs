import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";
import { registerCleanupRoutes } from "../server/src/routes/cleanup.mjs";
import { registerDeleteRoutes } from "../server/src/routes/delete.mjs";

test("cleanup recommendations stay review-only and duplicate hashing confirms exact matches", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-cleanup-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const root = path.join(directory, "indexed-root");
  await fs.mkdir(path.join(root, "Temp"), { recursive: true });
  const first = path.join(root, "same-a.bin");
  const second = path.join(root, "same-b.bin");
  const tempFile = path.join(root, "Temp", "interrupted.tmp");
  await fs.writeFile(first, "same bytes");
  await fs.writeFile(second, "same bytes");
  await fs.writeFile(tempFile, "temporary");
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, 'file', ?, ?, ?)");
  const now = new Date().toISOString();
  insert.run("one", root, first, path.basename(first), 10, now, now);
  insert.run("two", root, second, path.basename(second), 10, now, now);
  insert.run("temp", root, tempFile, path.basename(tempFile), 9, now, now);

  const handlers = new Map();
  registerCleanupRoutes({ get: (route, handler) => handlers.set(`GET ${route}`, handler), post: (route, handler) => handlers.set(`POST ${route}`, handler) }, db);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const invoke = async (route, request, method = "GET") => {
    const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
    const payload = await handlers.get(`${method} ${route}`)(request, reply);
    return { statusCode: reply.statusCode, body: reply.payload || payload };
  };

  const recommendations = await invoke("/api/cleanup/recommendations", { query: { root } });
  assert.equal(recommendations.statusCode, 200);
  assert.ok(recommendations.body.items.some((item) => item.name === "interrupted.tmp" && item.category === "temporary"));
  assert.equal(await fs.readFile(tempFile, "utf8"), "temporary", "recommendation discovery must not modify files");

  const duplicateGroups = await invoke("/api/cleanup/duplicate-groups", { query: { root } });
  assert.equal(duplicateGroups.body.groups.length, 1);
  const hashes = await invoke("/api/cleanup/duplicates/hash", { body: { ids: duplicateGroups.body.groups[0].ids } }, "POST");
  assert.equal(hashes.statusCode, 200);
  assert.equal(hashes.body.duplicates.length, 1);
  assert.equal(hashes.body.duplicates[0].items.length, 2);
  assert.equal(await fs.readFile(first, "utf8"), "same bytes", "hash comparison must not delete or change files");
});

test("delete preview submits a parent once when child entries are also selected", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-delete-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const root = path.join(directory, "selected-folder");
  await fs.mkdir(root);
  const file = path.join(root, "child.txt");
  await fs.writeFile(file, "fixture");
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("folder", root, root, "selected-folder", "directory", 0, "", "");
  insert.run("file", root, file, "child.txt", "file", 7, "", "");
  const completedAt = new Date().toISOString();
  db.prepare("INSERT INTO scan_runs (scan_id, root, status, started_at, completed_at, root_fingerprint) VALUES ('completed-folder', ?, 'completed', ?, ?, 'trusted-fingerprint')")
    .run(root, completedAt, completedAt);
  const handlers = new Map();
  registerDeleteRoutes({
    post: (route, handler) => handlers.set(`POST ${route}`, handler),
    get: (route, handler) => handlers.set(`GET ${route}`, handler),
  }, db);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  const result = await handlers.get("POST /api/delete")({ body: { ids: [2, 1], mode: "permanent" } }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(result.summary.deleted, 1);
  assert.equal(result.summary.covered, 1);
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  assert.equal(db.prepare("SELECT root_fingerprint FROM scan_runs WHERE scan_id = 'completed-folder'").get().root_fingerprint, null,
    "successful deletion invalidates the latest snapshot fingerprint");
  const history = await handlers.get("GET /api/delete/history")({ query: { limit: "20" } }, {});
  assert.equal(history.actions.length, 2);
  assert.deepEqual(new Set(history.actions.map((action) => action.outcome)), new Set(["completed", "covered"]));
  assert.ok(history.actions.every((action) => action.mode === "permanent" && action.actionId === result.actionId));
});

test("delete activity check asks once for selected parent folders and covered children", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-delete-activity-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const root = path.join(directory, "selected-folder");
  const childPath = path.join(root, "child.txt");
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, '', '')");
  insert.run("folder", root, root, "selected-folder", "directory", 0);
  insert.run("file", root, childPath, "child.txt", "file", 7);
  const handlers = new Map();
  let checked;
  registerDeleteRoutes({ post: (route, handler) => handlers.set(route, handler), get: () => {} }, db, {
    activityCheck: async (targets) => { checked = targets; return { status: "clear", checkedPaths: 1, processIds: [], message: "clear" }; },
  });
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  const result = await handlers.get("/api/delete/activity-check")({ body: { ids: [2, 1] } }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(result.selectedCount, 1);
  assert.deepEqual(checked, [{ id: 1, path: root, type: "directory" }]);
});

test("delete refuses a file whose indexed size is stale", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-stale-delete-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const root = path.join(directory, "root");
  await fs.mkdir(root);
  const file = path.join(root, "changed.txt");
  await fs.writeFile(file, "old");
  const stat = await fs.stat(file);
  db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES ('old', ?, ?, 'changed.txt', 'file', 3, ?, ?)")
    .run(root, file, stat.birthtime.toISOString(), stat.mtime.toISOString());
  const handlers = new Map();
  registerDeleteRoutes({
    post: (route, handler) => handlers.set(route, handler),
    get: (route, handler) => handlers.set(route, handler),
  }, db);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });

  await fs.writeFile(file, "new content after the scan");
  const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  const result = await handlers.get("/api/delete")({ body: { ids: [1], mode: "permanent" } }, reply);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].code, "STALE_INDEX");
  assert.equal(await fs.readFile(file, "utf8"), "new content after the scan");
});
