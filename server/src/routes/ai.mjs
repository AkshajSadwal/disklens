import { randomUUID } from "node:crypto";
import {
  analyzeFileWithAI,
  analyzeStorageTargetWithAI,
  analyzeStorageTopWithAI,
  buildFileInput,
  buildProviderRequest,
  buildStorageTargetInput,
  buildStorageTopInput,
  collectFileEvidence,
} from "../services/aiService.mjs";
import {
  getStorageTarget,
  getTopStorageSnapshot,
  searchStorageTargets,
} from "../services/storageAdvisor.mjs";
import { getAiSettings, getRuntimeAiConfig, removeAiSettings, saveAiSettings, testAiProvider, unlockAiSettings } from "../services/aiSettings.mjs";

const hostedPreviews = new Map();
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 32;

function configFingerprint(config) {
  return JSON.stringify({
    provider: config.provider || "local-rules",
    model: config.model || "",
    endpoint: config.endpoint || "",
    maxResponseTokens: config.maxResponseTokens || 800,
  });
}

function createPreview(type, value, config) {
  const now = Date.now();
  for (const [id, entry] of hostedPreviews) if (entry.expiresAt <= now) hostedPreviews.delete(id);
  while (hostedPreviews.size >= MAX_PREVIEWS) hostedPreviews.delete(hostedPreviews.keys().next().value);
  const id = randomUUID();
  hostedPreviews.set(id, { type, value, configFingerprint: configFingerprint(config), expiresAt: now + PREVIEW_TTL_MS });
  return id;
}

async function consumePreview(id, expectedType) {
  const preview = hostedPreviews.get(String(id || ""));
  hostedPreviews.delete(String(id || ""));
  if (!preview || preview.expiresAt <= Date.now() || preview.type !== expectedType) {
    const error = new Error("This AI preview expired. Review the input again before sending.");
    error.code = "AI_PREVIEW_EXPIRED";
    throw error;
  }
  if (preview.configFingerprint !== configFingerprint(await getRuntimeAiConfig())) {
    const error = new Error("AI settings changed after this preview. Review the new request before sending.");
    error.code = "AI_PREVIEW_SETTINGS_CHANGED";
    throw error;
  }
  return preview.value;
}

function createPromptPreview(config, prompt, outputLimit) {
  const maxResponseTokens = Math.min(outputLimit, config.maxResponseTokens || outputLimit);
  const providerRequest = buildProviderRequest(config, prompt.messages, prompt.responseSchema, maxResponseTokens);
  const requestBody = providerRequest?.body || { messages: prompt.messages, responseSchema: prompt.responseSchema };
  const inputBytes = Buffer.byteLength(JSON.stringify(requestBody));
  return {
    provider: config.provider,
    model: config.model || "local-rules",
    maxResponseTokens,
    inputBytes,
    estimatedInputTokens: Math.ceil(inputBytes / 4),
    messages: prompt.messages,
    responseSchema: prompt.responseSchema,
    requestBody,
  };
}

async function buildTopSnapshot(db, body = {}) {
  const include = body.include ?? {};
  const limit = Math.min(20, Math.max(1, Number(body.limit) || 10));
  if (!include.programs && !include.files && !include.folders) {
    const error = new Error("Select at least one of programs, files, or folders.");
    error.code = "INVALID_AI_SELECTION";
    throw error;
  }
  const snapshot = await getTopStorageSnapshot(db, {
    limit,
    include: {
      programs: include.programs !== false,
      files: include.files !== false,
      folders: include.folders !== false,
    },
  });
  for (const [type, rows] of Object.entries(snapshot.entities)) {
    for (const row of rows) {
      row.key = type === "program"
        ? `program:${row.name}|${row.version}|${row.publisher}`
        : `${type.slice(0, -1)}:${row.id}`;
    }
  }
  return snapshot;
}

export function registerAIRoutes(app, db) {
  app.get("/api/ai/status", async () => {
    const settings = await getAiSettings();
    return { ...settings, configured: settings.provider !== "local-rules", mode: settings.provider === "local-rules" ? "offline" : "hosted" };
  });

  app.get("/api/ai/settings", async () => getAiSettings());

  app.put("/api/ai/settings", async (request, reply) => {
    try {
      return await saveAiSettings(request.body || {});
    } catch (error) {
      const status = error.code === "CREDENTIAL_STORE_UNAVAILABLE" ? 503 : 400;
      return reply.code(status).send({ code: error.code || "AI_SETTINGS_ERROR", error: error.message || "Could not save AI settings." });
    }
  });

  app.post("/api/ai/settings/unlock", async (request, reply) => {
    try {
      return await unlockAiSettings(request.body?.passphrase);
    } catch (error) {
      return reply.code(400).send({ code: error.code || "LOCAL_SECRET_UNLOCK_FAILED", error: error.message || "Could not unlock the local credential." });
    }
  });

  app.delete("/api/ai/settings", async () => removeAiSettings());

  app.post("/api/ai/settings/test", async (request, reply) => {
    try {
      return await testAiProvider(request.body || {});
    } catch (error) {
      return reply.code(error.status || (error.code === "CREDENTIAL_STORE_UNAVAILABLE" ? 503 : 400))
        .send({ error: error.message || "Provider connection failed." });
    }
  });

  app.post("/api/ai/file/:id/preview", async (request, reply) => {
    try {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid id" });
      const item = db.prepare(`
        SELECT id, root, path, name, type, size,
               created_at AS createdAt,
               modified_at AS modifiedAt
        FROM items WHERE id = ?
      `).get(id);
      if (!item) return reply.code(404).send({ error: "Item not found" });
      if (item.type !== "file") return reply.code(400).send({ error: "AI file analysis requires a file." });
      const evidence = await collectFileEvidence(item);
      const prompt = buildFileInput(evidence);
      if (prompt.inputBytes > 32 * 1024) return reply.code(413).send({ error: "This preview exceeds the local AI input budget." });
      const config = await getRuntimeAiConfig();
      return {
        previewId: createPreview("file", { item, evidence }, config),
        ...createPromptPreview(config, prompt, 5000),
        expiresInSeconds: PREVIEW_TTL_MS / 1000,
      };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "TARGET_NOT_FOUND" ? 404 : 500;
      return reply.code(code).send({ error: error.message || "Could not prepare AI input preview." });
    }
  });

  app.post("/api/ai/file/:id", async (request, reply) => {
    try {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "Invalid id" });
      }

      const indexedItem = db.prepare(`
        SELECT id, root, path, name, type, size,
               created_at AS createdAt,
               modified_at AS modifiedAt
        FROM items
        WHERE id = ?
      `).get(id);

      if (!indexedItem) return reply.code(404).send({ error: "Item not found" });
      if (indexedItem.type !== "file") {
        return reply.code(400).send({ error: "AI file analysis requires a file." });
      }

      const { item, evidence } = request.body?.previewId
        ? await consumePreview(request.body.previewId, "file")
        : { item: indexedItem, evidence: await collectFileEvidence(indexedItem) };
      const analysis = await analyzeFileWithAI(evidence);

      return { item, evidence, analysis };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "AI_NOT_CONFIGURED" ? 503 : error.code === "AI_PREVIEW_EXPIRED" ? 410 : error.code === "AI_PREVIEW_SETTINGS_CHANGED" ? 409 : error.code === "AI_BUDGET_REACHED" ? 429 : 500;
      return reply.code(code).send({
        error: error.message || "AI file analysis failed.",
      });
    }
  });

  // Returns only the small, deterministic set of candidates that can be sent
  // to Azure OpenAI. This endpoint does not call AI.
  app.get("/api/ai/storage/search", async (request, reply) => {
    try {
      const type = String(request.query?.type || "").trim();
      const query = String(request.query?.q || "").trim();

      if (!["file", "folder"].includes(type)) {
        return reply.code(400).send({ error: "type must be file or folder" });
      }

      if (!query) return { items: [] };

      const items = await searchStorageTargets(db, {
        type,
        query,
        limit: 12,
      });

      return { items };
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({
        error: error.message || "Storage search failed.",
      });
    }
  });

  app.post("/api/ai/storage/top/preview", async (request, reply) => {
    try {
      const snapshot = await buildTopSnapshot(db, request.body ?? {});
      const prompt = buildStorageTopInput(snapshot);
      if (prompt.inputBytes > 32 * 1024) return reply.code(413).send({ error: "This preview exceeds the local AI input budget." });
      const config = await getRuntimeAiConfig();
      const previewId = createPreview("top", snapshot, config);
      return {
        previewId,
        ...createPromptPreview(config, prompt, 6500),
        expiresInSeconds: PREVIEW_TTL_MS / 1000,
      };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "INVALID_AI_SELECTION" ? 400 : 500;
      return reply.code(code).send({ error: error.message || "Could not prepare AI input preview." });
    }
  });

  app.post("/api/ai/storage/target/preview", async (request, reply) => {
    try {
      const target = await getStorageTarget(db, request.body ?? {});
      const prompt = buildStorageTargetInput(target);
      if (prompt.inputBytes > 32 * 1024) return reply.code(413).send({ error: "This preview exceeds the local AI input budget." });
      const config = await getRuntimeAiConfig();
      return {
        previewId: createPreview("target", target, config),
        ...createPromptPreview(config, prompt, 5000),
        expiresInSeconds: PREVIEW_TTL_MS / 1000,
      };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "TARGET_NOT_FOUND" || error.code === "INVALID_TARGET" ? 400 : 500;
      return reply.code(code).send({ error: error.message || "Could not prepare AI input preview." });
    }
  });

  // Mode 1: preview is generated without contacting a provider. The user then
  // submits the same server-held snapshot using its short-lived preview ID.
  app.post("/api/ai/storage/top", async (request, reply) => {
    try {
      const snapshot = request.body?.previewId
        ? await consumePreview(request.body.previewId, "top")
        : await buildTopSnapshot(db, request.body ?? {});
      const analysis = await analyzeStorageTopWithAI(snapshot);
      return { snapshot, analysis };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "AI_NOT_CONFIGURED" ? 503 : error.code === "AI_PREVIEW_EXPIRED" ? 410 : error.code === "AI_PREVIEW_SETTINGS_CHANGED" ? 409 : error.code === "AI_BUDGET_REACHED" ? 429 : error.code === "INVALID_AI_SELECTION" ? 400 : 500;
      return reply.code(code).send({
        error: error.message || "AI storage analysis failed.",
      });
    }
  });

  // Mode 2: analyze exactly one selected program/file/folder.
  app.post("/api/ai/storage/target", async (request, reply) => {
    try {
      const target = request.body?.previewId
        ? await consumePreview(request.body.previewId, "target")
        : await getStorageTarget(db, request.body ?? {});
      const analysis = await analyzeStorageTargetWithAI(target);
      return { target, analysis };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "AI_NOT_CONFIGURED" ? 503 : error.code === "AI_PREVIEW_EXPIRED" ? 410 : error.code === "AI_PREVIEW_SETTINGS_CHANGED" ? 409 : error.code === "AI_BUDGET_REACHED" ? 429 :
        error.code === "TARGET_NOT_FOUND" || error.code === "INVALID_TARGET" ? 400 : 500;
      return reply.code(code).send({
        error: error.message || "AI storage target analysis failed.",
      });
    }
  });
}
