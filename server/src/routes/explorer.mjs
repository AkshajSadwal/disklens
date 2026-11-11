import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function revealPath(targetPath, type) {
  if (process.platform === "win32") {
    const args = type === "file" ? [`/select,${targetPath}`] : [targetPath];
    await execFileAsync("explorer.exe", args, { windowsHide: true, timeout: 10000 });
    return;
  }
  if (process.platform === "darwin") {
    await execFileAsync("open", type === "file" ? ["-R", targetPath] : [targetPath], { timeout: 10000 });
    return;
  }
  const folder = type === "file" ? path.dirname(targetPath) : targetPath;
  await execFileAsync("xdg-open", [folder], { timeout: 10000 });
}

export function registerExplorerRoutes(app, db, { platform = process.platform } = {}) {
  app.get("/api/explorer/search", async (request, reply) => {
    const query = String(request.query?.q || "").trim().slice(0, 256);
    const queryField = String(request.query?.qField || "name").trim().toLowerCase();
    const extension = String(request.query?.extension || "").trim().toLowerCase().slice(0, 32);
    const type = String(request.query?.type || "").trim().toLowerCase();
    const scope = String(request.query?.path || "").trim();
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const separator = pathApi.sep.replace(/'/g, "''");
    const effectiveSize = `(CASE WHEN type = 'directory' THEN (SELECT COALESCE(SUM(child.size), 0) FROM items AS child WHERE child.root = items.root AND child.type = 'file' AND substr(child.path, 1, length(items.path) + 1) = items.path || '${separator}') ELSE size END)`;
    const sortColumns = { name: "name COLLATE NOCASE", size: effectiveSize, modified: "modified_at", type: "type" };
    const sort = sortColumns[request.query?.sort] || "name COLLATE NOCASE";
    const order = String(request.query?.order).toLowerCase() === "desc" ? "DESC" : "ASC";
    let page = Math.min(1_000_000, Math.max(1, Number.parseInt(request.query?.page, 10) || 1));
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.query?.limit, 10) || 50));
    const escapeLike = (value) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
    const escapeGlob = (value) => value.replace(/[\[*?]/g, (character) => ({ "[": "[[]", "*": "[*]", "?": "[?]" })[character]);
    const pathPrefixMatch = (value) => {
      const prefix = value.endsWith(pathApi.sep) ? value : `${value}${pathApi.sep}`;
      if (platform === "win32") {
        return {
          sql: "(path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '\\' COLLATE NOCASE)",
          params: [value, `${escapeLike(prefix)}%`],
        };
      }
      return { sql: "(path = ? OR path GLOB ?)", params: [value, `${escapeGlob(prefix)}*`] };
    };
    const conditions = [];
    const params = [];

    if (!["name", "path", "both"].includes(queryField)) {
      return reply.code(400).send({ error: "qField must be name, path, or both." });
    }
    if (query) {
      if (queryField === "name") {
        conditions.push("name LIKE ? ESCAPE '\\' COLLATE NOCASE");
        params.push(`${escapeLike(query)}%`);
      } else if (queryField === "path") {
        const match = pathPrefixMatch(query);
        conditions.push(match.sql);
        params.push(...match.params);
      } else {
        const match = pathPrefixMatch(query);
        conditions.push(`(name LIKE ? ESCAPE '\\' COLLATE NOCASE OR ${match.sql})`);
        params.push(`${escapeLike(query)}%`, ...match.params);
      }
    }
    if (extension) {
      const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
      conditions.push("lower(name) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(normalizedExtension)}`);
    }
    if (["file", "folder"].includes(type)) {
      conditions.push("type = ?");
      params.push(type === "folder" ? "directory" : "file");
    } else if (type && type !== "all") {
      return reply.code(400).send({ error: "type must be all, file, or folder." });
    }
    if (scope) {
      const separator = pathApi.sep;
      const prefix = scope.endsWith(separator) ? scope : `${scope}${separator}`;
      conditions.push("(path = ? OR substr(path, 1, length(?)) = ?)");
      params.push(scope, prefix, prefix);
    }
    for (const [field, operator] of [["minSize", ">="], ["maxSize", "<="]]) {
      const raw = request.query?.[field];
      if (raw !== undefined && raw !== "") {
        const value = Number(raw);
        if (!Number.isSafeInteger(Math.floor(value)) || value < 0) return reply.code(400).send({ error: `${field} must be a non-negative, safely sized byte value.` });
        conditions.push(`${effectiveSize} ${operator} ?`);
        params.push(Math.floor(value));
      }
    }
    for (const [field, operator] of [["modifiedAfter", ">="], ["modifiedBefore", "<="]]) {
      const raw = request.query?.[field];
      if (raw) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
          return reply.code(400).send({ error: `${field} must be an ISO date.` });
        }
        conditions.push(`modified_at ${operator} ?`);
        params.push(`${raw}${field === "modifiedBefore" ? "T23:59:59.999Z" : "T00:00:00.000Z"}`);
      }
    }

    const minSize = request.query?.minSize === undefined || request.query.minSize === "" ? null : Number(request.query.minSize);
    const maxSize = request.query?.maxSize === undefined || request.query.maxSize === "" ? null : Number(request.query.maxSize);
    if (minSize !== null && maxSize !== null && minSize > maxSize) return reply.code(400).send({ error: "minSize cannot be greater than maxSize." });
    if (request.query?.modifiedAfter && request.query?.modifiedBefore && request.query.modifiedAfter > request.query.modifiedBefore) {
      return reply.code(400).send({ error: "modifiedAfter cannot be later than modifiedBefore." });
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS count FROM items ${where}`).get(...params).count;
    const totalPages = Math.ceil(total / limit);
    page = Math.min(page, Math.max(totalPages, 1));
    const items = db.prepare(`
      SELECT id, root, path, name, type, size, created_at AS createdAt,
        modified_at AS modifiedAt, access_status AS accessStatus, error_code AS errorCode
      FROM items ${where}
      ORDER BY ${sort} ${order}, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);

    const folders = items.filter((item) => item.type === "directory");
    if (folders.length) {
      const ids = folders.map((item) => item.id);
      const placeholders = ids.map(() => "?").join(",");
      const aggregates = db.prepare(`
        SELECT parent.id,
          COALESCE(SUM(CASE WHEN child.type = 'file' THEN child.size ELSE 0 END), 0) AS size,
          COUNT(CASE WHEN child.type = 'file' THEN 1 END) AS fileCount,
          COUNT(CASE WHEN child.type = 'directory' THEN 1 END) AS folderCount
        FROM items AS parent
        LEFT JOIN items AS child
          ON child.root = parent.root
          AND substr(child.path, 1, length(parent.path) + 1) = parent.path || ?
        WHERE parent.id IN (${placeholders})
        GROUP BY parent.id
      `).all(path.sep, ...ids);
      const byId = new Map(aggregates.map((row) => [row.id, row]));
      for (const item of folders) {
        const aggregate = byId.get(item.id);
        item.indexedSize = Number(aggregate?.size) || 0;
        item.size = item.indexedSize;
        item.fileCount = Number(aggregate?.fileCount) || 0;
        item.folderCount = Number(aggregate?.folderCount) || 0;
      }
    }
    return { items, pagination: { page, limit, total, totalPages } };
  });

  app.post("/api/items/:id/open", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid id" });
    const item = db.prepare("SELECT id, path, type FROM items WHERE id = ?").get(id);
    if (!item) return reply.code(404).send({ error: "Item not found" });
    try {
      await revealPath(item.path, item.type === "file" ? "file" : "directory");
      return { ok: true };
    } catch (error) {
      request.log.warn({ error }, "Could not reveal item in the system file manager");
      return reply.code(500).send({ error: `Could not open the system file manager: ${error.message}` });
    }
  });

  app.post("/api/items/:id/open-folder", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid id" });
    const item = db.prepare("SELECT id, path, type FROM items WHERE id = ?").get(id);
    if (!item) return reply.code(404).send({ error: "Item not found" });
    const folderPath = item.type === "directory" ? item.path : path.dirname(item.path);
    try {
      await revealPath(folderPath, "directory");
      return { ok: true };
    } catch (error) {
      request.log.warn({ error }, "Could not open parent folder");
      return reply.code(500).send({ error: `Could not open the parent folder: ${error.message}` });
    }
  });
}
