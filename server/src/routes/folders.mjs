import path from "node:path";

export function registerFolderRoutes(app, db) {
  app.get("/api/folders", async (request, reply) => {
    const parent = request.query?.path;
    if (typeof parent !== "string" || !parent.trim()) {
      return reply.code(400).send({ error: "path is required" });
    }

    const separator = path.sep;
    const prefix = parent.endsWith(separator) ? parent : `${parent}${separator}`;
    const rows = db.prepare(`
      SELECT id, path, name, type, size, created_at AS createdAt, modified_at AS modifiedAt
      FROM items
      WHERE substr(path, 1, length(?)) = ?
      ORDER BY path
    `).all(prefix, prefix);

    const children = new Map();
    for (const row of rows) {
      if (!row.path.startsWith(prefix)) continue;
      const relative = row.path.slice(prefix.length);
      if (!relative) continue;
      const parts = relative.split(/[\\/]/).filter(Boolean);
      if (!parts.length) continue;
      const childName = parts[0];
      const childPath = `${prefix}${childName}`;

      if (!children.has(childPath)) {
        children.set(childPath, {
          id: null, name: childName, path: childPath, type: "directory",
          size: 0, fileCount: 0, folderCount: 0, createdAt: null, modifiedAt: null,
        });
      }
      const child = children.get(childPath);
      if (parts.length === 1) {
        child.id = row.id;
        child.type = row.type;
        child.createdAt = row.createdAt;
        child.modifiedAt = row.modifiedAt;
      }
      if (row.type === "file") {
        child.size += Number(row.size) || 0;
        child.fileCount += 1;
      } else if (row.type === "directory" && parts.length > 1) {
        child.folderCount += 1;
      }
    }

    return [...children.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return (b.size - a.size) || a.name.localeCompare(b.name);
    });
  });
}
