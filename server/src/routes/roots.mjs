export function normalizeRootKey(root, platform = process.platform) {
  const original = String(root || "").trim();
  if (!original) return "";
  if (platform === "win32") {
    if (original === "/" || original === "\\") return original;
    let value = original.replace(/[\\/]+$/, "");
    // Treat a bare Windows drive designator (C:) and its absolute root
    // (C:\\) as the same indexed location.
    if (/^[a-zA-Z]:$/.test(value)) value += "\\";
    return value.toLocaleUpperCase("en-US");
  }
  // POSIX paths are case-sensitive (including macOS volumes formatted that
  // way); only trailing separators are aliases on these platforms.
  if (/^\/+$/.test(original)) return "/";
  return original.replace(/\/+$/, "") || "/";
}

export function registerRootRoutes(app, db, { platform = process.platform } = {}) {
  app.get("/api/roots", async () => {
    // Include completed empty scans and registered drive roots, then merge
    // aliases such as "C:" and "C:\\". Prefer the spelling associated with
    // actual indexed items so navigation uses the same root value as items.
    const rows = db.prepare(`
      WITH known_roots AS (
        SELECT root FROM items WHERE root IS NOT NULL AND root != ''
        UNION
        SELECT root FROM scan_runs WHERE status = 'completed'
        UNION
        SELECT root FROM drives WHERE root IS NOT NULL AND root != ''
      )
      SELECT
        roots.root AS root,
        COALESCE(SUM(CASE WHEN items.type = 'file' THEN items.size ELSE 0 END), 0) AS size,
        COUNT(items.id) AS itemCount,
        COALESCE(SUM(CASE WHEN items.type = 'file' THEN 1 ELSE 0 END), 0) AS fileCount,
        COALESCE(SUM(CASE WHEN items.type = 'directory' THEN 1 ELSE 0 END), 0) AS folderCount
      FROM known_roots AS roots
      LEFT JOIN items ON items.root = roots.root
      GROUP BY roots.root
      ORDER BY roots.root
    `).all();

    const merged = new Map();
    for (const row of rows) {
      const key = normalizeRootKey(row.root, platform);
      if (!key) continue;
      const current = merged.get(key);
      if (!current) {
        merged.set(key, { ...row, _representativeCount: Number(row.itemCount) || 0 });
        continue;
      }

      current.size += Number(row.size) || 0;
      current.itemCount += Number(row.itemCount) || 0;
      current.fileCount += Number(row.fileCount) || 0;
      current.folderCount += Number(row.folderCount) || 0;
      // A populated root is canonical for navigation; empty drive metadata
      // rows should never replace the path used by the indexed items.
      if ((Number(row.itemCount) || 0) > current._representativeCount) {
        current.root = row.root;
        current._representativeCount = Number(row.itemCount) || 0;
      }
    }

    return [...merged.values()]
      .map(({ _representativeCount, ...row }) => row)
      .sort((a, b) => String(a.root).localeCompare(String(b.root)));
  });
}
