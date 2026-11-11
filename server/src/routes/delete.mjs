import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { deleteItem } from "../services/deleteService.mjs";
import { checkFilesystemActivity } from "../services/fileActivity.mjs";

export function registerDeleteRoutes(app, db, { activityCheck = checkFilesystemActivity } = {}) {
  app.post("/api/delete/activity-check", async (request, reply) => {
    const { ids } = request.body || {};
    if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || ids.some((id) => !Number.isInteger(Number(id)))) {
      return reply.code(400).send({ error: "ids must be a non-empty array of item IDs." });
    }
    const uniqueIds = [...new Set(ids.map(Number))];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const items = db.prepare(`SELECT id, path, type FROM items WHERE id IN (${placeholders})`).all(...uniqueIds);
    const directories = items.filter((item) => item.type === "directory");
    const targets = items.filter((item) => ["file", "directory"].includes(item.type) && !directories.some((directory) => {
      if (directory.id === item.id) return false;
      const relative = path.relative(path.resolve(directory.path), path.resolve(item.path));
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }));
    if (!targets.length) return reply.code(400).send({ error: "No selected files or folders can be checked." });
    return { selectedCount: targets.length, ...(await activityCheck(targets)) };
  });

  app.get("/api/delete/history", async (request, reply) => {
    const rawLimit = request.query?.limit;
    if (rawLimit !== undefined && !/^\d+$/.test(String(rawLimit))) return reply.code(400).send({ error: "limit must be a positive integer." });
    const limit = Math.min(100, Math.max(1, Number.parseInt(rawLimit, 10) || 20));
    const actions = db.prepare(`
      SELECT id, action_id AS actionId, item_id AS itemId, root, path,
        item_name AS itemName, mode, outcome, error, created_at AS createdAt
      FROM cleanup_actions ORDER BY id DESC LIMIT ?
    `).all(limit);
    return { actions };
  });

  app.post("/api/delete", async (request, reply) => {
    const { ids, mode } = request.body ?? {};

    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 2000 ||
      ids.some((id) => !Number.isInteger(Number(id)))
    ) {
      return reply.code(400).send({
        error: "ids must be a non-empty array of item IDs",
      });
    }

    if (mode !== "recycle" && mode !== "permanent") {
      return reply.code(400).send({
        error: "mode must be recycle or permanent",
      });
    }

    const uniqueIds = [...new Set(ids.map(Number))];

    const placeholders = uniqueIds.map(() => "?").join(",");
    const items = db
      .prepare(`
        SELECT id, root, path, name, type, size, modified_at AS modifiedAt
        FROM items
        WHERE id IN (${placeholders})
      `)
      .all(...uniqueIds);

    const byId = new Map(items.map((item) => [item.id, item]));
    const removeIndexedItem = db.transaction((item) => {
      if (item.type === "directory") {
        const prefix = item.path.endsWith(path.sep) ? item.path : `${item.path}${path.sep}`;
        db.prepare("DELETE FROM items WHERE path = ? OR substr(path, 1, length(?)) = ?").run(item.path, prefix, prefix);
      } else {
        db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
      }
      // A manual delete changes the indexed snapshot. Invalidate the latest
      // completed fingerprint so a later identical filesystem scan cannot
      // incorrectly skip reconciliation and leave deleted rows behind.
      db.prepare(`
        UPDATE scan_runs SET root_fingerprint = NULL
        WHERE scan_id = (
          SELECT scan_id FROM scan_runs WHERE root = ? AND status = 'completed'
          ORDER BY completed_at DESC, scan_id DESC LIMIT 1
        )
      `).run(item.root);
    });
    const results = [];
    const selectedDirectories = items.filter((item) => item.type === "directory");
    const completedDirectories = new Set();
    const orderedIds = [...uniqueIds].sort((firstId, secondId) =>
      String(byId.get(firstId)?.path || "").length - String(byId.get(secondId)?.path || "").length,
    );

    for (const id of orderedIds) {
      const item = byId.get(id);

      if (!item) {
        results.push({
          id,
          ok: false,
          error: "Item not found in DiskLens index.",
          code: "NOT_FOUND",
        });
        continue;
      }

      const coveredByDirectory = selectedDirectories.some((directory) => {
        if (directory.id === item.id || !completedDirectories.has(directory.id)) return false;
        const relative = path.relative(path.resolve(directory.path), path.resolve(item.path));
        return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      });
      if (coveredByDirectory) {
        results.push({ id, ok: true, name: item.name, path: item.path, mode: "included-in-selected-folder" });
        continue;
      }

      if (item.type !== "file" && item.type !== "directory") {
        results.push({
          id,
          ok: false,
          error: "Only files and folders can be deleted by this feature.",
          code: "UNSUPPORTED_TYPE",
        });
        continue;
      }

      try {
        if (item.type === "file") {
          const current = await fs.lstat(item.path);
          const indexedTime = Date.parse(item.modifiedAt || "");
          if (current.size !== Number(item.size) || (Number.isFinite(indexedTime) && current.mtime.getTime() !== indexedTime)) {
            const error = new Error("This file changed after its last scan. Rescan and review it again before deleting.");
            error.code = "STALE_INDEX";
            throw error;
          }
        }
        await deleteItem(item.path, item.type, mode);
        removeIndexedItem(item);

        if (item.type === "directory") completedDirectories.add(item.id);

        results.push({
          id: item.id,
          ok: true,
          name: item.name,
          path: item.path,
          mode,
        });
      } catch (error) {
        results.push({
          id: item.id,
          ok: false,
          name: item.name,
          path: item.path,
          error: error.message,
          code: error.code || "DELETE_FAILED",
        });
      }
    }

    const failed = results.filter((result) => !result.ok);
    const actionId = randomUUID();
    const createdAt = new Date().toISOString();
    const insertAction = db.prepare(`
      INSERT INTO cleanup_actions (action_id, item_id, root, path, item_name, mode, outcome, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const result of results) {
        const item = byId.get(result.id);
        insertAction.run(
          actionId, result.id, item?.root || "", result.path || item?.path || "",
          result.name || item?.name || "", mode,
          result.ok ? result.mode === "included-in-selected-folder" ? "covered" : "completed" : "failed",
          result.error || null, createdAt,
        );
      }
    })();

    return {
      actionId,
      ok: failed.length === 0,
      mode,
      results,
      summary: {
        requested: uniqueIds.length,
        deleted: results.filter((result) => result.ok && result.mode !== "included-in-selected-folder").length,
        covered: results.filter((result) => result.mode === "included-in-selected-folder").length,
        failed: failed.length,
      },
    };
  });
}
