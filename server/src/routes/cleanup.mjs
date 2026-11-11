import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ensureSafeDeletePath } from "../services/deleteService.mjs";

const MAX_HASH_FILES = 20;
const MAX_HASH_BYTES = 128 * 1024 * 1024;

function candidateReason(item, cutoff) {
  const lowerPath = String(item.path || "").toLowerCase();
  const extension = path.extname(item.name || "").toLowerCase();
  if (/(^|[\\/])(temp|tmp)([\\/]|$)/.test(lowerPath) || [".tmp", ".temp"].includes(extension)) {
    return { category: "temporary", reason: "Temporary folder or file extension; verify it is not part of an active operation." };
  }
  if (/(^|[\\/])cache([\\/]|$)/.test(lowerPath) || extension === ".cache") {
    return { category: "cache", reason: "Cache location or extension; confirm the owning application can rebuild it." };
  }
  const modified = Date.parse(item.modifiedAt || "");
  if (Number.isFinite(modified) && modified < cutoff && Number(item.size) >= 50 * 1024 * 1024) {
    return { category: "large-old", reason: "Large file has not been modified within the selected age window; age does not prove it is unused." };
  }
  return null;
}

export function registerCleanupRoutes(app, db) {
  app.get("/api/cleanup/recommendations", async (request, reply) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(request.query?.limit, 10) || 100));
    const ageDays = Math.min(3650, Math.max(30, Number.parseInt(request.query?.ageDays, 10) || 365));
    const minBytes = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number(request.query?.minBytes) || 0));
    const root = typeof request.query?.root === "string" ? request.query.root.trim() : "";
    if (root.length > 32768) return reply.code(400).send({ error: "Invalid root." });
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoff).toISOString();
    const rows = db.prepare(`
      SELECT id, root, path, name, type, size, modified_at AS modifiedAt
      FROM items WHERE type = 'file' AND size >= ?
        AND (
          replace(lower(path), char(92), '/') LIKE '%/temp/%'
          OR replace(lower(path), char(92), '/') LIKE '%/tmp/%'
          OR replace(lower(path), char(92), '/') LIKE '%/cache/%'
          OR lower(name) LIKE '%.tmp' OR lower(name) LIKE '%.temp' OR lower(name) LIKE '%.cache'
          OR (size >= 52428800 AND modified_at < ?)
        )
        ${root ? "AND root = ?" : ""}
      ORDER BY size DESC, id ASC LIMIT ?
    `).all(...(root ? [minBytes, cutoffIso, root, 1000] : [minBytes, cutoffIso, 1000]));
    const items = [];
    for (const row of rows) {
      const candidate = candidateReason(row, cutoff);
      if (!candidate) continue;
      try { ensureSafeDeletePath(row.path); } catch { continue; }
      items.push({ ...row, ...candidate, estimatedBytes: Number(row.size) || 0 });
      if (items.length >= limit) break;
    }
    return {
      items,
      count: items.length,
      ageDays,
      estimatedReclaimableBytes: items.reduce((total, item) => total + item.estimatedBytes, 0),
      estimateNote: "Potential space only. Review every item; the index cannot determine whether data is still needed or whether an application can rebuild it.",
    };
  });

  app.get("/api/cleanup/duplicate-groups", async (request, reply) => {
    const limit = Math.min(50, Math.max(1, Number.parseInt(request.query?.limit, 10) || 25));
    const root = typeof request.query?.root === "string" ? request.query.root.trim() : "";
    if (root.length > 32768) return reply.code(400).send({ error: "Invalid root." });
    const groups = db.prepare(`
      SELECT size, COUNT(*) AS count
      FROM items WHERE type = 'file' AND size > 0 ${root ? "AND root = ?" : ""}
      GROUP BY size HAVING COUNT(*) > 1
      ORDER BY size * COUNT(*) DESC, size DESC LIMIT ?
    `).all(...(root ? [root, limit] : [limit]));
    const idsForSize = db.prepare(`SELECT id FROM items WHERE type = 'file' AND size = ? ${root ? "AND root = ?" : ""} ORDER BY path LIMIT ?`);
    return {
      groups: groups.map((group) => ({
        size: Number(group.size), count: Number(group.count),
        ids: idsForSize.all(...(root ? [group.size, root, MAX_HASH_FILES] : [group.size, MAX_HASH_FILES])).map((row) => row.id),
      })),
      note: "Equal size is only a prefilter. DiskLens reads file bytes only after you choose Compare hashes.",
    };
  });

  app.post("/api/cleanup/duplicates/hash", async (request, reply) => {
    const ids = Array.isArray(request.body?.ids) ? [...new Set(request.body.ids.map(Number))] : [];
    if (ids.length < 2 || ids.length > MAX_HASH_FILES || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      return reply.code(400).send({ error: `Choose between 2 and ${MAX_HASH_FILES} indexed file IDs to compare.` });
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, root, path, name, size FROM items WHERE id IN (${placeholders}) AND type = 'file'`).all(...ids);
    if (rows.length !== ids.length) return reply.code(400).send({ error: "All selected items must still be indexed files." });
    if (new Set(rows.map((item) => item.size)).size !== 1) return reply.code(400).send({ error: "Compare files of the same size to limit unnecessary hashing." });
    const totalBytes = rows.reduce((sum, item) => sum + Number(item.size), 0);
    if (totalBytes > MAX_HASH_BYTES) return reply.code(413).send({ error: "This comparison exceeds the 128 MiB hash budget. Choose a smaller same-size group." });

    const hashed = [];
    for (const row of rows) {
      try {
        ensureSafeDeletePath(row.path);
        const stat = await fs.lstat(row.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Number(row.size)) throw new Error("File changed since it was indexed.");
        const hash = crypto.createHash("sha256");
        await new Promise((resolve, reject) => {
          const stream = createReadStream(row.path);
          stream.on("data", (chunk) => hash.update(chunk));
          stream.once("error", reject);
          stream.once("end", resolve);
        });
        hashed.push({ ...row, sha256: hash.digest("hex") });
      } catch (error) {
        hashed.push({ id: row.id, name: row.name, path: row.path, size: row.size, error: error.message });
      }
    }
    const groups = new Map();
    for (const item of hashed) {
      if (!item.sha256) continue;
      if (!groups.has(item.sha256)) groups.set(item.sha256, []);
      groups.get(item.sha256).push(item);
    }
    return {
      compared: hashed.length,
      errors: hashed.filter((item) => item.error),
      duplicates: [...groups.entries()].filter(([, items]) => items.length > 1).map(([sha256, items]) => ({ sha256, items })),
      note: "Exact content matches are identified by SHA-256. No files were moved or deleted.",
    };
  });
}
