export function registerRootRoutes(app, db) {
  app.get("/api/roots", async () => {
    return db
      .prepare(`
        SELECT
          root,
          SUM(CASE WHEN type = 'file' THEN size ELSE 0 END) AS size,
          COUNT(*) AS itemCount,
          SUM(CASE WHEN type = 'file' THEN 1 ELSE 0 END) AS fileCount,
          SUM(CASE WHEN type = 'directory' THEN 1 ELSE 0 END) AS folderCount
        FROM items
        GROUP BY root
        ORDER BY root
      `)
      .all();
  });
}
