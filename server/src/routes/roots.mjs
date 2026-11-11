export function registerRootRoutes(app, db) {
  app.get("/api/roots", async () => {
    // Include completed empty scans and explicitly registered drive roots too.
    // Otherwise an empty folder disappears from Home and cannot be rescanned.
    return db.prepare(`
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
  });
}
