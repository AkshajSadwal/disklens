import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { countRootEntries, isPrivacyExcluded, scanRoot } from "../collector/src/scanner.mjs";

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "disklens-test-"));
}

function mockScanServer(handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    await handler(body, response);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  }));
}

test("privacy filter excludes credential and private-key artifacts", () => {
  assert.equal(isPrivacyExcluded(".env"), true);
  assert.equal(isPrivacyExcluded(".env.production"), true);
  assert.equal(isPrivacyExcluded("id_ed25519"), true);
  assert.equal(isPrivacyExcluded("credentials.json"), true);
  assert.equal(isPrivacyExcluded("id_rsa.pub"), true);
  assert.equal(isPrivacyExcluded(".ssh", true), true);
  assert.equal(isPrivacyExcluded("report.pdf"), false);
  assert.equal(isPrivacyExcluded("photos", true), false);
});

test("count pass ignores private files and does not recurse through symlinks", async (t) => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "docs"));
  await fs.mkdir(path.join(root, ".ssh"));
  await fs.writeFile(path.join(root, "visible.txt"), "hello");
  await fs.writeFile(path.join(root, ".env"), "TOKEN=secret");
  await fs.writeFile(path.join(root, "docs", "readme.md"), "docs");
  await fs.writeFile(path.join(root, "docs", "id_rsa"), "private");
  await fs.writeFile(path.join(outside, "outside.txt"), "not followed");
  try { await fs.symlink(outside, path.join(root, "linked-folder"), "dir"); } catch { t.skip("Symbolic links are not available in this environment."); return; }

  const count = await countRootEntries({ root });
  assert.equal(count, 4); // docs/, visible.txt, linked-folder, docs/readme.md
});

test("empty and normal scans use staged start/complete protocol", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "one.txt"), "one");
  await fs.writeFile(path.join(root, ".env"), "PRIVATE=1");

  const phases = [];
  const uploadedItems = [];
  const mock = await mockScanServer(async (body, response) => {
    phases.push(body.phase);
    uploadedItems.push(...(body.items || []));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body.phase === "complete" ? { status: "completed" } : { ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  const stats = { totalItems: 0, uploadedItems: 0, skippedItems: 0 };
  const result = await scanRoot({ root, server: mock.url, stats });
  assert.equal(result.status, "completed");
  assert.equal(result.scanned, 1);
  assert.equal(stats.totalItems, 1);
  assert.equal(uploadedItems.length, 1);
  assert.equal(uploadedItems[0].name, "one.txt");
  assert.ok(phases.includes("start"));
  assert.ok(phases.includes("progress"));
  assert.ok(phases.includes("batch"));
  assert.ok(phases.includes("complete"));
});

test("empty folder still completes a scan and replaces the previous index", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const phases = [];
  const mock = await mockScanServer(async (body, response) => {
    phases.push(body.phase);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  const result = await scanRoot({ root, server: mock.url, stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0 } });
  assert.equal(result.scanned, 0);
  assert.deepEqual(phases, ["start", "progress", "progress", "complete"]);
});

test("cancelling during estimate aborts the staged scan without completing it", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "file.txt"), "data");
  const phases = [];
  const mock = await mockScanServer(async (body, response) => {
    phases.push(body.phase);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));
  const controller = new AbortController();
  await assert.rejects(
    scanRoot({
      root,
      server: mock.url,
      stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0,
        onEstimate: () => controller.abort() },
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(phases, ["start", "abort"]);
});


test("root becoming unreadable after scan staging aborts instead of replacing the previous index", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "file.txt"), "data");
  const phases = [];
  const mock = await mockScanServer(async (body, response) => {
    phases.push(body.phase);
    if (body.phase === "start") await fs.rm(root, { recursive: true, force: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  await assert.rejects(
    scanRoot({ root, server: mock.url, stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0 } }),
    /Cannot read the selected scan folder/,
  );
  assert.deepEqual(phases, ["start", "abort"]);
  assert.equal(phases.includes("complete"), false);
});
