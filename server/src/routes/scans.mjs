import { randomUUID } from "node:crypto";

export function registerScanRoutes(app, db) {
  app.post("/api/scans", async (request, reply) => {
    const { root, scanId, replace, items } = request.body ?? {};

    if (typeof root !== "string" || !Array.isArray(items)) {
      return reply.code(400).send({
        error: "root and items are required",
      });
    }

    const finalScanId =
      typeof scanId === "string" && scanId ? scanId : randomUUID();

    if (replace) {
      db.prepare(`
        DELETE FROM items
        WHERE root = ?
      `).run(root);
    }

    const insert = db.prepare(`
      INSERT INTO items (
        scan_id, root, path, name, type, size, created_at, modified_at,
        access_status, error_code
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((rows) => {
      for (const item of rows) {
        insert.run(
          finalScanId,
          root,
          item.path,
          item.name,
          item.type,
          Number(item.size) || 0,
          item.createdAt || "",
          item.modifiedAt || "",
          item.accessStatus || "accessible",
          item.errorCode || null,
        );
      }
    });

    transaction(items);

    return {
      scanId: finalScanId,
      count: items.length,
    };
  });
}
