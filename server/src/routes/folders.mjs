import path from "node:path";

export function registerFolderRoutes(app, db, { platform = process.platform } = {}) {
  app.get("/api/folders", async (request, reply) => {
    const parent = request.query?.path;
    if (typeof parent !== "string" || !parent.trim()) {
      return reply.code(400).send({ error: "path is required" });
    }

    const separator = platform === "win32" ? "\\" : path.posix.sep;
    const prefix = parent.endsWith(separator) ? parent : `${parent}${separator}`;
    const isWindows = platform === "win32";
    const upperBound = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
    const matchSql = isWindows
      ? "path > ? COLLATE NOCASE AND path < ? COLLATE NOCASE"
      : "path > ? AND path < ?";

    // Aggregate descendants in SQLite instead of materializing every indexed
    // file row in Node. Prefix matching uses the existing path index, which is
    // important for large indexes containing hundreds of thousands of rows.
    const rows = db.prepare(`
      WITH descendants AS (
        SELECT id, path, type, size, created_at AS createdAt,
          modified_at AS modifiedAt,
          substr(path, length(?) + 1) AS relative
        FROM items
        WHERE ${matchSql}
      ), named AS (
        SELECT *, substr(
          relative,
          1,
          CASE WHEN instr(relative, ?) = 0
            THEN length(relative)
            ELSE instr(relative, ?) - 1
          END
        ) AS childName
        FROM descendants
      )
      SELECT
        MAX(CASE WHEN relative = childName THEN id END) AS id,
        childName AS name,
        ? || childName AS path,
        COALESCE(MAX(CASE WHEN relative = childName THEN type END), 'directory') AS type,
        COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0) AS size,
        SUM(CASE WHEN type = 'file' THEN 1 ELSE 0 END) AS fileCount,
        SUM(CASE WHEN type = 'directory' AND relative <> childName THEN 1 ELSE 0 END) AS folderCount,
        MAX(CASE WHEN relative = childName THEN createdAt END) AS createdAt,
        MAX(CASE WHEN relative = childName THEN modifiedAt END) AS modifiedAt
      FROM named
      GROUP BY childName
      ORDER BY CASE WHEN type = 'directory' THEN 0 ELSE 1 END,
        size DESC, name COLLATE NOCASE
    `).all(prefix, prefix, upperBound, separator, separator, prefix);

    return rows.map((row) => ({
      ...row,
      size: Number(row.size) || 0,
      fileCount: Number(row.fileCount) || 0,
      folderCount: Number(row.folderCount) || 0,
    }));
  });
}
