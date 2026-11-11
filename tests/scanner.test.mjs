import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { countRootEntries, isPrivacyExcluded, scanRoot } from "../collector/src/scanner.mjs";
import { bindCancellationInput } from "../collector/src/control.mjs";
import { PassThrough } from "node:stream";

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "disklens-test-"));
}

async function createDirectoryLink(target, linkPath) {
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
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


test("parent-process cancel command aborts the collector through stdin", () => {
  const input = new PassThrough();
  const controller = new AbortController();
  let notified = 0;
  const channel = bindCancellationInput(input, controller, () => { notified += 1; });
  input.write("can");
  assert.equal(controller.signal.aborted, false);
  input.write("cel\n");
  assert.equal(controller.signal.aborted, true);
  assert.equal(channel.cancelled, true);
  assert.equal(notified, 1);
  channel.requestCancellation();
  assert.equal(notified, 1, "duplicate cancellation commands are ignored");
  channel.dispose();
});

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
  try { await createDirectoryLink(outside, path.join(root, "linked-folder")); } catch { t.skip("Directory links are not available in this environment."); return; }

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

test("scanner spills a broad directory frontier and still visits every child", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 80; index += 1) {
    const child = path.join(root, `folder-${index}`);
    await fs.mkdir(child);
    await fs.writeFile(path.join(child, `file-${index}.txt`), "x");
  }

  const uploadedItems = [];
  const mock = await mockScanServer(async (body, response) => {
    uploadedItems.push(...(body.items || []));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  const result = await scanRoot({
    root,
    server: mock.url,
    directoryQueueLimit: 2,
    stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0 },
  });
  assert.equal(result.totalEntries, 160);
  assert.equal(result.scanned, 160);
  assert.equal(uploadedItems.filter((item) => item.type === "file").length, 80);
  assert.equal(new Set(uploadedItems.map((item) => item.path)).size, 160);
});

test("repeat scans reuse the prior count estimate but still collect all current entries", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(["one.txt", "two.txt", "three.txt"].map((name) => fs.writeFile(path.join(root, name), name)));
  const progressUpdates = [];
  const mock = await mockScanServer(async (body, response) => {
    if (body.phase === "progress") progressUpdates.push({ scanned: body.scanned, total: body.total });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body.phase === "start" ? { previousItemCount: 2 } : { ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  let estimatePassStarted = false;
  const result = await scanRoot({
    root,
    server: mock.url,
    stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0, onEstimate: () => { estimatePassStarted = true; } },
  });
  assert.equal(estimatePassStarted, false, "known roots skip the duplicate directory-count pass");
  assert.equal(result.scanned, 3, "the collector still enumerates every current entry");
  assert.equal(result.totalEntries, 3, "the final count replaces the provisional estimate");
  assert.deepEqual(progressUpdates.at(-1), { scanned: 3, total: 3 });
});

test("collector reads entry metadata concurrently with a fixed bound", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(path.join(root, `bounded-${index}.txt`), "x");
  }

  const uploadedItems = [];
  const mock = await mockScanServer(async (body, response) => {
    uploadedItems.push(...(body.items || []));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body.phase === "start" ? { previousItemCount: 40 } : { ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  let activeReads = 0;
  let peakReads = 0;
  const result = await scanRoot({
    root,
    server: mock.url,
    lstat: async (target) => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try { return await fs.lstat(target); }
      finally { activeReads -= 1; }
    },
    stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0 },
  });

  assert.equal(result.scanned, 40);
  assert.equal(uploadedItems.length, 40);
  assert.ok(peakReads > 1, `metadata reads were serialized (peak ${peakReads})`);
  assert.ok(peakReads <= 16, `metadata concurrency exceeded its bound (${peakReads})`);
});

test("cancellation during a metadata window aborts before uploading its results", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 20; index += 1) {
    await fs.writeFile(path.join(root, `cancel-window-${index}.txt`), "x");
  }

  const phases = [];
  const mock = await mockScanServer(async (body, response) => {
    phases.push(body.phase);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body.phase === "start" ? { previousItemCount: 20 } : { ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  let startedResolve;
  const windowStarted = new Promise((resolve) => { startedResolve = resolve; });
  let releaseReads;
  const readGate = new Promise((resolve) => { releaseReads = resolve; });
  let startedReads = 0;
  const controller = new AbortController();
  const scan = scanRoot({
    root,
    server: mock.url,
    signal: controller.signal,
    lstat: async (target) => {
      startedReads += 1;
      if (startedReads === 16) startedResolve();
      await readGate;
      return fs.lstat(target);
    },
    stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0 },
  });

  await windowStarted;
  controller.abort();
  releaseReads();
  await assert.rejects(scan, { name: "AbortError" });
  assert.ok(phases.includes("abort"));
  assert.equal(phases.includes("batch"), false);
  assert.equal(phases.includes("complete"), false);
});

test("directory access loss during traversal is recorded as skipped and does not fail the scan", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inaccessible = path.join(root, "private-after-estimate");
  await fs.mkdir(inaccessible);
  await fs.writeFile(path.join(inaccessible, "retained.txt"), "x");
  await Promise.all(Array.from({ length: 24 }, (_, index) =>
    fs.writeFile(path.join(root, `file-${String(index).padStart(2, "0")}.txt`), "x"),
  ));

  const accessUpdates = [];
  const progressUpdates = [];
  const mock = await mockScanServer(async (body, response) => {
    if (body.phase === "access") accessUpdates.push(body);
    if (body.phase === "progress") progressUpdates.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body.phase === "complete" ? { status: "completed" } : { ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  let removed = false;
  const result = await scanRoot({
    root,
    server: mock.url,
    stats: {
      totalItems: 0, uploadedItems: 0, skippedItems: 0,
      onProgress: ({ scanned }) => {
        if (!removed && scanned === 25) {
          fsSync.rmSync(inaccessible, { recursive: true, force: true });
          removed = true;
        }
      },
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.skipped, 1);
  assert.equal(accessUpdates.length, 1);
  assert.equal(accessUpdates[0].path, inaccessible);
  assert.equal(accessUpdates[0].accessStatus, "denied");
  assert.equal(progressUpdates.at(-1).skipped, 1);
});


test("scan publishes intermediate progress before the upload batch completes", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 160 }, (_, index) =>
    fs.writeFile(path.join(root, `file-${String(index).padStart(3, "0")}.txt`), "x"),
  ));

  const progressUpdates = [];
  const mock = await mockScanServer(async (body, response) => {
    if (body.phase === "progress") progressUpdates.push(body.scanned);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  const result = await scanRoot({
    root,
    server: mock.url,
    stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0 },
  });
  assert.equal(result.scanned, 160);
  assert.ok(progressUpdates.some((count) => count >= 75 && count < 160), "an intermediate progress value should be persisted");
  assert.equal(progressUpdates.at(-1), 160, "the final progress value should reach 100 percent");
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


test("cancellation during a batch upload aborts instead of committing partial results", async (t) => {
  const root = await temporaryDirectory();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "one.txt"), "data");

  const phases = [];
  let batchReceivedResolve;
  const batchReceived = new Promise((resolve) => { batchReceivedResolve = resolve; });
  const mock = await mockScanServer(async (body, response) => {
    phases.push(body.phase);
    if (body.phase === "batch") {
      batchReceivedResolve();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!response.destroyed) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    }
  });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));

  const controller = new AbortController();
  const scan = scanRoot({
    root,
    server: mock.url,
    stats: { totalItems: 0, uploadedItems: 0, skippedItems: 0 },
    signal: controller.signal,
  });
  await batchReceived;
  controller.abort();
  await assert.rejects(scan, { name: "AbortError" });
  assert.ok(phases.includes("abort"));
  assert.equal(phases.includes("complete"), false);
});


test("symbolic-link scan roots are rejected before a staging scan starts", async (t) => {
  const parent = await temporaryDirectory();
  const actual = path.join(parent, "actual");
  const alias = path.join(parent, "alias");
  await fs.mkdir(actual);
  try {
    await createDirectoryLink(actual, alias);
  } catch {
    t.skip("Directory links are not available in this environment.");
    return;
  }
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await assert.rejects(
    scanRoot({ root: alias, server: "http://127.0.0.1:1", stats: {}, signal: new AbortController().signal }),
    /cannot be a symbolic link/i,
  );
});
