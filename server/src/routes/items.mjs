import path from "node:path";
export function registerItemRoutes(app, db, { platform = process.platform } = {}) {
  app.get("/api/items", async (request) => {
    const page = Math.max(Number(request.query?.page) || 1, 1);
    const limit = Math.min(Number(request.query?.limit) || 100, 500);
    const offset = (page - 1) * limit;

    const search = String(request.query?.search || "").trim();
    const type = String(request.query?.type || "").trim();

    const allowedSorts = {
      size: "size",
      name: "name",
      created: "created_at",
      modified: "modified_at",
    };

    const sort = allowedSorts[request.query?.sort] || "size";
    const order =
      String(request.query?.order).toLowerCase() === "asc" ? "ASC" : "DESC";

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push("(name LIKE ? OR path LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (type) {
      conditions.push("type = ?");
      params.push(type);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const total = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM items
        ${where}
      `)
      .get(...params).count;

    const items = db
      .prepare(`
        SELECT
          id, root, path, name, type, size,
          created_at AS createdAt,
          modified_at AS modifiedAt
        FROM items
        ${where}
        ORDER BY ${sort} ${order}
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  app.get("/api/items/:id", async (request, reply) => {
    const id = Number(request.params.id);

    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "Invalid id" });
    }

    const item = db
      .prepare(`
        SELECT
          id, root, path, name, type, size,
          created_at AS createdAt,
          modified_at AS modifiedAt
        FROM items
        WHERE id = ?
      `)
      .get(id);

    if (!item) {
      return reply.code(404).send({ error: "Item not found" });
    }

    if (item.type === "directory") {
      const pathApi = platform === "win32" ? path.win32 : path.posix;
      const prefix = item.path.endsWith(pathApi.sep) ? item.path : `${item.path}${pathApi.sep}`;
      const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
      const collation = platform === "win32" ? " COLLATE NOCASE" : "";
      const stats = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0) AS totalSize,
          COUNT(CASE WHEN type = 'file' THEN 1 END) AS fileCount,
          COUNT(CASE WHEN type = 'directory' THEN 1 END) AS folderCount
        FROM items
        WHERE path > ?${collation} AND path < ?${collation}
      `).get(prefix, upperBound);

      return {
        ...item,
        size: Number(stats.totalSize) || 0,
        fileCount: Number(stats.fileCount) || 0,
        folderCount: Math.max(Number(stats.folderCount) || 0, 0),
      };
    }

    return item;
  });
}
