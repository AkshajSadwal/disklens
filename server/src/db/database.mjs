import Database from "better-sqlite3";

export function createDatabase(filename = "disklens.db") {
  const db = new Database(filename);

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL,
      root TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      access_status TEXT NOT NULL DEFAULT 'accessible',
      error_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_items_scan_id
    ON items(scan_id);
  `);

  return db;
}
