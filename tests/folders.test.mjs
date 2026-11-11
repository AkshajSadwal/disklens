import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";
import { registerFolderRoutes } from "../server/src/routes/folders.mjs";

async function makeRoute(t, platform) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-folders-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const handlers = new Map();
  registerFolderRoutes({ get: (route, handler) => handlers.set(route, handler) }, db, { platform });
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { db, handler: handlers.get("/api/folders") };
}

function invoke(handler, value) {
  const reply = { statusCode: 200, code(status) { this.statusCode = status; return this; }, send(payload) { this.payload = payload; return payload; } };
  return Promise.resolve(handler({ query: { path: value } }, reply)).then((result) => ({ statusCode: reply.statusCode, body: reply.payload ?? result }));
}

test("folder listing aggregates immediate children and descendant totals in SQLite", async (t) => {
  const { db, handler } = await makeRoute(t, "linux");
  const root = "/fixture";
  const rows = [
    [root, "/fixture/Alpha", "Alpha", "directory", 0],
    [root, "/fixture/Alpha/Nested", "Nested", "directory", 0],
    [root, "/fixture/Alpha/report.pdf", "report.pdf", "file", 100],
    [root, "/fixture/Alpha/Nested/deep.txt", "deep.txt", "file", 50],
    [root, "/fixture/Beta", "Beta", "directory", 0],
    [root, "/fixture/Beta/image.png", "image.png", "file", 300],
    [root, "/fixture/notes.pdf", "notes.pdf", "file", 25],
  ];
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES ('scan', ?, ?, ?, ?, ?, '', '')");
  db.transaction(() => rows.forEach((row) => insert.run(...row)))();

  const { body, statusCode } = await invoke(handler, root);
  assert.equal(statusCode, 200);
  assert.deepEqual(body.map((row) => row.name), ["Beta", "Alpha", "notes.pdf"]);
  const alpha = body.find((row) => row.name === "Alpha");
  assert.equal(alpha.type, "directory");
  assert.equal(alpha.size, 150);
  assert.equal(alpha.fileCount, 2);
  assert.equal(alpha.folderCount, 1);
  assert.ok(alpha.id);
  const beta = body.find((row) => row.name === "Beta");
  assert.equal(beta.size, 300);
  assert.equal(beta.fileCount, 1);
  assert.equal(beta.folderCount, 0);
  const directFile = body.find((row) => row.name === "notes.pdf");
  assert.equal(directFile.type, "file");
  assert.equal(directFile.size, 25);
  assert.equal(directFile.fileCount, 1);

  const queryPlan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM items WHERE path > ? AND path < ?").all("/fixture/", "/fixture0");
  assert.ok(queryPlan.some((row) => String(row.detail).includes("SEARCH items") && String(row.detail).includes("idx_items_path")), queryPlan.map((row) => row.detail).join("; "));
});

test("folder listing preserves case-sensitive POSIX paths and handles glob characters literally", async (t) => {
  const { db, handler } = await makeRoute(t, "linux");
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES ('scan', '/fixture', ?, ?, ?, ?, '', '')");
  insert.run("/fixture/A/upper.txt", "upper.txt", "file", 10);
  insert.run("/fixture/a/lower.txt", "lower.txt", "file", 20);
  insert.run("/fixture/A*/literal?[x].txt", "literal?[x].txt", "file", 30);

  const upper = await invoke(handler, "/fixture/A");
  assert.deepEqual(upper.body.map((row) => row.name), ["upper.txt"]);
  const lower = await invoke(handler, "/fixture/a");
  assert.deepEqual(lower.body.map((row) => row.name), ["lower.txt"]);
  const glob = await invoke(handler, "/fixture/A*");
  assert.deepEqual(glob.body.map((row) => row.name), ["literal?[x].txt"]);
});

test("folder listing matches Windows paths case-insensitively and excludes prefix siblings", async (t) => {
  const { db, handler } = await makeRoute(t, "win32");
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES ('scan', 'C:\\Root', ?, ?, ?, ?, '', '')");
  insert.run("C:\\Root\\Alpha", "Alpha", "directory", 0);
  insert.run("C:\\Root\\Alpha\\report.txt", "report.txt", "file", 10);
  insert.run("C:\\Root\\Alpha-other\\skip.txt", "skip.txt", "file", 20);

  const result = await invoke(handler, "c:\\root\\alpha");
  assert.deepEqual(result.body.map((row) => row.name), ["report.txt"]);
  assert.equal(result.body[0].size, 10);
  assert.equal(result.body[0].fileCount, 1);
  const queryPlan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM items WHERE path > ? COLLATE NOCASE AND path < ? COLLATE NOCASE").all("C:\\Root\\", "C:\\Root\\]");
  assert.ok(queryPlan.some((row) => String(row.detail).includes("SEARCH items") && String(row.detail).includes("idx_items_path_nocase")), queryPlan.map((row) => row.detail).join("; "));
});

test("folder listing rejects an empty path", async (t) => {
  const { handler } = await makeRoute(t, "linux");
  const result = await invoke(handler, " ");
  assert.equal(result.statusCode, 400);
  assert.deepEqual(result.body, { error: "path is required" });
});

test("drive-root listing excludes the root row and returns only direct children", async (t) => {
  const { db, handler } = await makeRoute(t, "win32");
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES ('scan', ?, ?, ?, ?, ?, '', '')");
  insert.run("C:\\", "C:\\", "C:\\", "directory", 0);
  insert.run("C:\\", "C:\\Users", "Users", "directory", 0);
  insert.run("C:\\", "C:\\Users\\Akshaj", "Akshaj", "directory", 0);
  insert.run("C:\\", "C:\\Users\\Akshaj\\notes.txt", "notes.txt", "file", 42);

  const result = await invoke(handler, "C:\\");
  assert.deepEqual(result.body.map((row) => row.name), ["Users"]);
  assert.equal(result.body[0].size, 42);
  assert.equal(result.body[0].fileCount, 1);
  assert.equal(result.body[0].folderCount, 1);
});
