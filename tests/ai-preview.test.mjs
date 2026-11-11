import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../server/src/db/database.mjs";

test("advisor preview is sanitized, has no provider call, and sends its one-use snapshot", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-ai-preview-"));
  const previous = {
    config: process.env.DISKLENS_CONFIG_DIR,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    azure: process.env.AZURE_OPENAI_API_KEY,
  };
  process.env.DISKLENS_CONFIG_DIR = path.join(directory, "config");
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AZURE_OPENAI_API_KEY;

  const { registerAIRoutes } = await import("../server/src/routes/ai.mjs");
  const db = createDatabase(path.join(directory, "fixture.db"));
  const root = path.join(directory, "root");
  await fs.mkdir(root, { recursive: true });
  const oldName = "private-file-name.txt";
  const filePath = path.join(root, oldName);
  await fs.writeFile(filePath, "private file content that must not appear in the hosted preview");
  const insert = db.prepare("INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("fixture", root, filePath, oldName, "file", 4096, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  const routes = new Map();
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
    put: (route, handler) => routes.set(`PUT ${route}`, handler),
    delete: (route, handler) => routes.set(`DELETE ${route}`, handler),
  };
  registerAIRoutes(app, db);
  const invoke = async (route, body = {}, method = "POST") => {
    const fileMatch = /^\/api\/ai\/file\/(\d+)(\/preview)?$/.exec(route);
    const routeTemplate = fileMatch ? `/api/ai/file/:id${fileMatch[2] || ""}` : route;
    const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
    const payload = await routes.get(`${method} ${routeTemplate}`)({ body, params: fileMatch ? { id: fileMatch[1] } : {}, query: {}, log: { error() {}, warn() {} } }, reply);
    return { statusCode: reply.statusCode, body: reply.payload || payload };
  };

  t.after(async () => {
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      DISKLENS_CONFIG_DIR: previous.config,
      OPENAI_API_KEY: previous.openai,
      ANTHROPIC_API_KEY: previous.anthropic,
      AZURE_OPENAI_API_KEY: previous.azure,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const preview = await invoke("/api/ai/storage/top/preview", { include: { programs: false, files: true, folders: false }, limit: 5 });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.provider, "local-rules");
  assert.equal(JSON.stringify(preview.body.messages).includes(oldName), false);
  assert.equal(JSON.stringify(preview.body.messages).includes(root), false);
  assert.equal(preview.body.inputBytes > 0, true);
  assert.equal(preview.body.estimatedInputTokens, Math.ceil(preview.body.inputBytes / 4));

  db.prepare("UPDATE items SET name = ?, path = ? WHERE id = 1").run("changed-after-preview.txt", path.join(root, "changed-after-preview.txt"));
  const result = await invoke("/api/ai/storage/top", { previewId: preview.body.previewId });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.snapshot.entities.files[0].name, oldName);
  assert.equal(result.body.analysis.source, "local-rules");

  const reused = await invoke("/api/ai/storage/top", { previewId: preview.body.previewId });
  assert.equal(reused.statusCode, 410);

  db.prepare("UPDATE items SET name = ?, path = ? WHERE id = 1").run(oldName, filePath);
  const filePreview = await invoke(`/api/ai/file/1/preview`);
  assert.equal(filePreview.statusCode, 200);
  const promptText = JSON.stringify({ messages: filePreview.body.messages, responseSchema: filePreview.body.responseSchema });
  assert.equal(promptText.includes(oldName), false);
  assert.equal(promptText.includes(directory), false);
  assert.equal(promptText.includes("private file content"), false);
  const fileAnalysis = await invoke("/api/ai/file/1", { previewId: filePreview.body.previewId });
  assert.equal(fileAnalysis.statusCode, 200);
  assert.equal(fileAnalysis.body.analysis.source, "local-rules");

  const stalePreview = await invoke("/api/ai/storage/top/preview", { include: { programs: false, files: true, folders: false }, limit: 5 });
  assert.equal(stalePreview.statusCode, 200);
  const changedSettings = await invoke("/api/ai/settings", { provider: "local-rules", maxResponseTokens: 900 }, "PUT");
  assert.equal(changedSettings.statusCode, 200);
  const staleSend = await invoke("/api/ai/storage/top", { previewId: stalePreview.body.previewId });
  assert.equal(staleSend.statusCode, 409);
});
