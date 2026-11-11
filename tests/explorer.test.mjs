import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";
import { registerExplorerRoutes } from "../server/src/routes/explorer.mjs";

test("explorer search filters, paginates, and calculates folder sizes from indexed files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-explorer-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const root = path.join(directory, "indexed-root");
  const rows = [
    ["dir-a", root, path.join(root, "Alpha"), "Alpha", "directory", 0, "2025-01-01T00:00:00.000Z"],
    ["dir-n", root, path.join(root, "Alpha", "Nested"), "Nested", "directory", 0, "2025-01-01T00:00:00.000Z"],
    ["dir-b", root, path.join(root, "Beta"), "Beta", "directory", 0, "2025-01-01T00:00:00.000Z"],
    ["file-a", root, path.join(root, "Alpha", "report.pdf"), "report.pdf", "file", 100, "2025-02-01T00:00:00.000Z"],
    ["file-n", root, path.join(root, "Alpha", "Nested", "deep.txt"), "deep.txt", "file", 50, "2025-03-01T00:00:00.000Z"],
    ["file-b", root, path.join(root, "Beta", "image.png"), "image.png", "file", 300, "2025-04-01T00:00:00.000Z"],
    ["file-root", root, path.join(root, "notes.pdf"), "notes.pdf", "file", 25, "2025-05-01T00:00:00.000Z"],
  ];
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => rows.forEach(([id, itemRoot, itemPath, name, type, size, modified]) => insert.run(id, itemRoot, itemPath, name, type, size, modified, modified)))();
  const handlers = new Map();
  const app = { get: (route, handler) => handlers.set(route, handler), post: () => {} };
  registerExplorerRoutes(app, db);
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const handler = handlers.get("/api/explorer/search");
  const invoke = async (query) => {
    const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
    const payload = await handler({ query }, reply);
    return { statusCode: reply.statusCode, body: reply.payload || payload };
  };

  const params = new URLSearchParams({ path: root, type: "folder", sort: "size", order: "desc", limit: "1" });
  const page = await invoke(Object.fromEntries(params));
  assert.equal(page.statusCode, 200);
  const body = page.body;
  assert.equal(body.pagination.total, 3);
  assert.equal(body.pagination.totalPages, 3);
  assert.equal(body.items[0].name, "Beta");
  assert.equal(body.items[0].indexedSize, 300);

  const filtered = await invoke({ path: root, extension: ".pdf", minSize: "50" });
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(filtered.body.items.map((item) => item.name), ["report.pdf"]);

  const byPath = await invoke({ path: root, qField: "path", q: path.join(root, "Alpha") });
  assert.equal(byPath.statusCode, 200);
  assert.deepEqual(byPath.body.items.map((item) => item.name).sort(), ["Alpha", "Nested", "deep.txt", "report.pdf"].sort());

  const byNameOrPath = await invoke({ path: root, qField: "both", q: "notes" });
  assert.equal(byNameOrPath.statusCode, 200);
  assert.deepEqual(byNameOrPath.body.items.map((item) => item.name), ["notes.pdf"]);

  const badRange = await invoke({ path: root, minSize: "-1" });
  assert.equal(badRange.statusCode, 400);
  const badSearchField = await invoke({ path: root, qField: "content" });
  assert.equal(badSearchField.statusCode, 400);

  const pathIndex = process.platform === "win32" ? "idx_items_path_nocase" : "idx_items_path";
  const pathPlan = process.platform === "win32"
    ? db.prepare("EXPLAIN QUERY PLAN SELECT id FROM items WHERE path LIKE ? ESCAPE '\\' COLLATE NOCASE").all(`${root.replace(/[\\%_]/g, (character) => `\\${character}`)}%`)
    : db.prepare("EXPLAIN QUERY PLAN SELECT id FROM items WHERE path GLOB ?").all(`${root.replace(/([\\[*?])/g, "[$1]")}/*`);
  assert.ok(pathPlan.some((row) => String(row.detail).includes(pathIndex)), `Expected indexed path-prefix search, got: ${pathPlan.map((row) => row.detail).join("; ")}`);
});

test("POSIX path-prefix searches preserve case and escape glob metacharacters", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-posix-explorer-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const rows = [
    ["upper-dir", "/fixture", "/fixture/A", "A", "directory", 0],
    ["upper-file", "/fixture", "/fixture/A/Report.TXT", "Report.TXT", "file", 10],
    ["lower-dir", "/fixture", "/fixture/a", "a", "directory", 0],
    ["lower-file", "/fixture", "/fixture/a/report.txt", "report.txt", "file", 20],
    ["literal-star", "/fixture", "/fixture/A*/Report.txt", "Report.txt", "file", 30],
    ["literal-globs", "/fixture", "/fixture/A*/literal?[x]/child.txt", "child.txt", "file", 40],
    ["prefix-sibling", "/fixture", "/fixture/Alpha/other.txt", "other.txt", "file", 50],
  ];
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, '', '')");
  db.transaction(() => rows.forEach((row) => insert.run(...row)))();
  const handlers = new Map();
  registerExplorerRoutes({ get: (route, handler) => handlers.set(route, handler), post: () => {} }, db, { platform: "linux" });
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const handler = handlers.get("/api/explorer/search");
  const invoke = async (query) => {
    const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
    const payload = await handler({ query }, reply);
    return reply.payload || payload;
  };

  const uppercase = await invoke({ path: "/fixture", qField: "path", q: "/fixture/A" });
  assert.deepEqual(uppercase.items.map((item) => item.path).sort(), ["/fixture/A", "/fixture/A/Report.TXT"]);
  const lower = await invoke({ path: "/fixture", qField: "path", q: "/fixture/a" });
  assert.deepEqual(lower.items.map((item) => item.path).sort(), ["/fixture/a", "/fixture/a/report.txt"]);
  const literalStar = await invoke({ path: "/fixture", qField: "path", q: "/fixture/A*" });
  assert.deepEqual(literalStar.items.map((item) => item.path).sort(), [
    "/fixture/A*/Report.txt", "/fixture/A*/literal?[x]/child.txt",
  ]);
  const pathPlan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM items WHERE path GLOB ?").all("/fixture/A/*");
  assert.ok(pathPlan.some((row) => String(row.detail).includes("idx_items_path")), `Expected indexed POSIX path-prefix search, got: ${pathPlan.map((row) => row.detail).join("; ")}`);
});

test("Windows path-prefix searches match case-insensitively", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-windows-explorer-"));
  const db = createDatabase(path.join(directory, "fixture.db"));
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, '', '')");
  insert.run("dir", "C:\\Root", "C:\\Root\\Alpha", "Alpha", "directory", 0);
  insert.run("file", "C:\\Root", "C:\\Root\\Alpha\\report.txt", "report.txt", "file", 10);
  insert.run("sibling", "C:\\Root", "C:\\Root\\Alpha-other\\skip.txt", "skip.txt", "file", 20);
  const handlers = new Map();
  registerExplorerRoutes({ get: (route, handler) => handlers.set(route, handler), post: () => {} }, db, { platform: "win32" });
  t.after(async () => { db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const reply = { code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  const result = await handlers.get("/api/explorer/search")({ query: { path: "C:\\Root", qField: "path", q: "c:\\root\\alpha" } }, reply);
  assert.equal(reply.statusCode || 200, 200);
  assert.deepEqual((result.items || reply.payload.items).map((item) => item.path).sort(), ["C:\\Root\\Alpha", "C:\\Root\\Alpha\\report.txt"]);
});
