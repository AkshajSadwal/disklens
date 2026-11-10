import { spawn } from "node:child_process";
import path from "node:path";

export function registerExplorerRoutes(app, db) {
  app.post("/api/items/:id/open", async (request, reply) => {
    const id = Number(request.params.id);

    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "Invalid id" });
    }

    const item = db
      .prepare(`
        SELECT id, path, type
        FROM items
        WHERE id = ?
      `)
      .get(id);

    if (!item) {
      return reply.code(404).send({ error: "Item not found" });
    }

    try {
      if (item.type === "file") {
        spawn("explorer.exe", [`/select,${item.path}`], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } else {
        spawn("explorer.exe", [item.path], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }

      return { ok: true };
    } catch (error) {
      return reply.code(500).send({ error: error.message });
    }
  });

  app.post("/api/items/:id/open-folder", async (request, reply) => {
    const id = Number(request.params.id);

    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "Invalid id" });
    }

    const item = db
      .prepare(`
        SELECT id, path, type
        FROM items
        WHERE id = ?
      `)
      .get(id);

    if (!item) {
      return reply.code(404).send({ error: "Item not found" });
    }

    const folderPath =
      item.type === "directory" ? item.path : path.dirname(item.path);

    spawn("explorer.exe", [folderPath], {
      detached: true,
      stdio: "ignore",
    }).unref();

    return { ok: true };
  });
}
