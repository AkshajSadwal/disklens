import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";
import { registerScanRoutes } from "../server/src/routes/scans.mjs";

test("scan commit updates only changed rows and retains inaccessible descendants", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-scan-commit-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const root = path.join(directory, "indexed-root");
  const privateDir = path.join(root, "private");
  const paths = {
    stable: path.join(root, "stable.txt"),
    deleted: path.join(root, "deleted.txt"),
    privateDir,
    privateFile: path.join(privateDir, "keep.txt"),
    added: path.join(root, "added.txt"),
  };
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at, access_status) VALUES ('old', ?, ?, ?, ?, ?, '', '', 'accessible')");
  insert.run(root, paths.stable, "stable.txt", "file", 1);
  insert.run(root, paths.deleted, "deleted.txt", "file", 2);
  insert.run(root, paths.privateDir, "private", "directory", 0);
  insert.run(root, paths.privateFile, "keep.txt", "file", 3);

  const handlers = new Map();
  registerScanRoutes({ post: (route, handler) => handlers.set(route, handler), get: () => {}, addHook: () => {}, log: { info() {}, warn() {}, error() {} } }, db);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const invoke = async (body) => {
    const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
    const payload = await handlers.get("/api/scans")({ body, log: { info() {}, warn() {}, error() {} } }, reply);
    assert.equal(reply.statusCode, 200, JSON.stringify(reply.payload));
    return reply.payload || payload;
  };

  const oldStableId = db.prepare("SELECT id FROM items WHERE path = ?").get(paths.stable).id;
  await invoke({ phase: "start", root, scanId: "scan-one" });
  await invoke({ phase: "batch", root, scanId: "scan-one", items: [
    { path: paths.stable, name: "stable.txt", type: "file", size: 1 },
    { path: paths.privateDir, name: "private", type: "directory", size: 0, accessStatus: "denied", errorCode: "EACCES" },
    { path: paths.added, name: "added.txt", type: "file", size: 4 },
  ] });
  const first = await invoke({ phase: "complete", root, scanId: "scan-one" });
  assert.equal(first.status, "completed");
  assert.ok(db.prepare("SELECT 1 FROM items WHERE path = ?").get(paths.privateFile), "previous descendants under inaccessible folders remain indexed");
  assert.equal(db.prepare("SELECT id FROM items WHERE path = ?").get(paths.stable).id, oldStableId, "unchanged item rows are preserved");
  assert.equal(db.prepare("SELECT 1 FROM items WHERE path = ?").get(paths.deleted), undefined, "deleted paths in accessible areas are removed");
  assert.ok(db.prepare("SELECT 1 FROM items WHERE path = ?").get(paths.added), "new paths are inserted");
  assert.equal(db.prepare("SELECT item_count FROM scan_runs WHERE scan_id = 'scan-one'").get().item_count, 4);
  assert.equal(db.prepare("SELECT indexed_bytes FROM scan_runs WHERE scan_id = 'scan-one'").get().indexed_bytes, 8);
  assert.deepEqual({
    added: first.addedCount, changed: first.changedCount, unchanged: first.unchangedCount,
    removed: first.removedCount, preserved: first.preservedCount,
  }, { added: 1, changed: 1, unchanged: 1, removed: 1, preserved: 1 });

  await invoke({ phase: "start", root, scanId: "scan-two" });
  await invoke({ phase: "batch", root, scanId: "scan-two", items: [
    { path: paths.stable, name: "stable.txt", type: "file", size: 5 },
    { path: paths.privateDir, name: "private", type: "directory", size: 0, accessStatus: "accessible" },
    { path: paths.added, name: "added.txt", type: "file", size: 4 },
  ] });
  await invoke({ phase: "access", root, scanId: "scan-two", path: paths.privateDir, accessStatus: "denied", errorCode: "EACCES" });
  const second = await invoke({ phase: "complete", root, scanId: "scan-two" });
  assert.equal(second.fingerprintMatchesPrevious, null, "access-limited scans do not claim a fingerprint comparison");
  assert.ok(db.prepare("SELECT 1 FROM items WHERE path = ?").get(paths.privateFile), "runtime access failures preserve previously indexed descendants");
  assert.equal(db.prepare("SELECT indexed_bytes FROM scan_runs WHERE scan_id = 'scan-two'").get().indexed_bytes, 12);
  assert.deepEqual({
    added: second.addedCount, changed: second.changedCount, unchanged: second.unchangedCount,
    removed: second.removedCount, preserved: second.preservedCount,
  }, { added: 0, changed: 1, unchanged: 2, removed: 0, preserved: 1 });

  await invoke({ phase: "start", root, scanId: "scan-three" });
  await invoke({ phase: "batch", root, scanId: "scan-three", items: [
    { path: paths.stable, name: "stable.txt", type: "file", size: 5 },
    { path: paths.added, name: "added.txt", type: "file", size: 4 },
  ] });
  await invoke({ phase: "complete", root, scanId: "scan-three" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM items WHERE root = ?").get(root).count, 2);
  assert.equal(db.prepare("SELECT size FROM items WHERE path = ?").get(paths.stable).size, 5, "changed metadata is updated in place");
  assert.equal(db.prepare("SELECT indexed_bytes FROM scan_runs WHERE scan_id = 'scan-three'").get().indexed_bytes, 9);
  assert.equal(db.prepare("SELECT removed_count FROM scan_runs WHERE scan_id = 'scan-three'").get().removed_count, 2);
  const completeFingerprint = db.prepare("SELECT root_fingerprint, fingerprint_matches_previous FROM scan_runs WHERE scan_id = 'scan-three'").get();
  assert.match(completeFingerprint.root_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(completeFingerprint.fingerprint_matches_previous, null, "first complete accessible snapshot has no previous fingerprint");

  await invoke({ phase: "start", root, scanId: "scan-four" });
  await invoke({ phase: "batch", root, scanId: "scan-four", items: [
    { path: paths.stable, name: "stable.txt", type: "file", size: 5 },
    { path: paths.added, name: "added.txt", type: "file", size: 4 },
  ] });
  const fourth = await invoke({ phase: "complete", root, scanId: "scan-four" });
  assert.equal(fourth.fingerprintMatchesPrevious, true, "matching complete snapshots receive a stable content-fingerprint signal");
  assert.equal(db.prepare("SELECT fingerprint_matches_previous FROM scan_runs WHERE scan_id = 'scan-four'").get().fingerprint_matches_previous, 1);

  const hiddenDirectory = path.join(root, "hidden");
  const staleHiddenPath = path.join(hiddenDirectory, "stale.txt");
  insert.run(root, hiddenDirectory, "hidden", "directory", 0);
  insert.run(root, staleHiddenPath, "stale.txt", "file", 7);
  await invoke({ phase: "start", root, scanId: "scan-five" });
  await invoke({ phase: "batch", root, scanId: "scan-five", items: [
    { path: paths.stable, name: "stable.txt", type: "file", size: 5 },
    { path: paths.added, name: "added.txt", type: "file", size: 4 },
    { path: hiddenDirectory, name: "hidden", type: "directory", size: 0, accessStatus: "denied", errorCode: "EACCES" },
  ] });
  await invoke({ phase: "complete", root, scanId: "scan-five" });
  assert.ok(db.prepare("SELECT 1 FROM items WHERE path = ?").get(staleHiddenPath), "the denied directory retains its stale descendant");

  await invoke({ phase: "start", root, scanId: "scan-six" });
  await invoke({ phase: "batch", root, scanId: "scan-six", items: [
    { path: paths.stable, name: "stable.txt", type: "file", size: 5 },
    { path: paths.added, name: "added.txt", type: "file", size: 4 },
  ] });
  const sixth = await invoke({ phase: "complete", root, scanId: "scan-six" });
  assert.equal(sixth.fingerprintMatchesPrevious, null, "a scan after a partial scan must not match an older complete snapshot");
  assert.equal(db.prepare("SELECT 1 FROM items WHERE path = ?").get(staleHiddenPath), undefined, "full reconciliation removes stale descendants after access is restored");
});
