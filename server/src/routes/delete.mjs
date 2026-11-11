import path from "node:path";
import { deleteItem } from "../services/deleteService.mjs";

export function registerDeleteRoutes(app, db) {
  app.post("/api/delete", async (request, reply) => {
    const { ids, mode } = request.body ?? {};

    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
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
        SELECT id, root, path, name, type, size
        FROM items
        WHERE id IN (${placeholders})
      `)
      .all(...uniqueIds);

    const byId = new Map(items.map((item) => [item.id, item]));
    const results = [];

    for (const id of uniqueIds) {
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
        await deleteItem(item.path, item.type, mode);

        if (item.type === "directory") {
          const prefix = item.path.endsWith(path.sep) ? item.path : `${item.path}${path.sep}`;
          db.prepare("DELETE FROM items WHERE path = ? OR substr(path, 1, length(?)) = ?").run(item.path, prefix, prefix);
        } else {
          db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
        }

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

    return {
      ok: failed.length === 0,
      mode,
      results,
      summary: {
        requested: uniqueIds.length,
        deleted: results.filter((result) => result.ok).length,
        failed: failed.length,
      },
    };
  });
}
