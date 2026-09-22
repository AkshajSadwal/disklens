import {
  analyzeFileWithAI,
  analyzeStorageTargetWithAI,
  analyzeStorageTopWithAI,
  collectFileEvidence,
} from "../services/aiService.mjs";
import {
  getStorageTarget,
  getTopStorageSnapshot,
  searchStorageTargets,
} from "../services/storageAdvisor.mjs";

export function registerAIRoutes(app, db) {
  app.get("/api/ai/status", async () => ({
    configured: Boolean(
      process.env.AZURE_OPENAI_API_KEY?.trim() &&
      process.env.AZURE_OPENAI_ENDPOINT?.trim() &&
      process.env.AZURE_OPENAI_DEPLOYMENT?.trim(),
    ),
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT?.trim() || null,
  }));

  app.post("/api/ai/file/:id", async (request, reply) => {
    try {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "Invalid id" });
      }

      const item = db.prepare(`
        SELECT id, root, path, name, type, size,
               created_at AS createdAt,
               modified_at AS modifiedAt
        FROM items
        WHERE id = ?
      `).get(id);

      if (!item) return reply.code(404).send({ error: "Item not found" });
      if (item.type !== "file") {
        return reply.code(400).send({ error: "AI file analysis requires a file." });
      }

      const evidence = await collectFileEvidence(item);
      const analysis = await analyzeFileWithAI(evidence);

      return { item, evidence, analysis };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "AI_NOT_CONFIGURED" ? 503 : 500;
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

  // Mode 1: user chooses how many of the largest programs/files/folders to
  // send to AI. The server builds the small snapshot first.
  app.post("/api/ai/storage/top", async (request, reply) => {
    try {
      const body = request.body ?? {};
      const include = body.include ?? {};
      const limit = Math.min(50, Math.max(1, Number(body.limit) || 10));

      if (!include.programs && !include.files && !include.folders) {
        return reply.code(400).send({
          error: "Select at least one of programs, files, or folders.",
        });
      }

      const snapshot = await getTopStorageSnapshot(db, {
        limit,
        include: {
          programs: include.programs !== false,
          files: include.files !== false,
          folders: include.folders !== false,
        },
      });

      // Give every entity a stable key so the model can cite only supplied data.
      for (const [type, rows] of Object.entries(snapshot.entities)) {
        for (const row of rows) {
          row.key = type === "program"
            ? `program:${row.name}|${row.version}|${row.publisher}`
            : `${type.slice(0, -1)}:${row.id}`;
        }
      }

      const analysis = await analyzeStorageTopWithAI(snapshot);
      return { snapshot, analysis };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "AI_NOT_CONFIGURED" ? 503 : 500;
      return reply.code(code).send({
        error: error.message || "AI storage analysis failed.",
      });
    }
  });

  // Mode 2: analyze exactly one selected program/file/folder.
  app.post("/api/ai/storage/target", async (request, reply) => {
    try {
      const target = await getStorageTarget(db, request.body ?? {});
      const analysis = await analyzeStorageTargetWithAI(target);
      return { target, analysis };
    } catch (error) {
      request.log.error(error);
      const code = error.code === "AI_NOT_CONFIGURED" ? 503 :
        error.code === "TARGET_NOT_FOUND" || error.code === "INVALID_TARGET" ? 400 : 500;
      return reply.code(code).send({
        error: error.message || "AI storage target analysis failed.",
      });
    }
  });
}
