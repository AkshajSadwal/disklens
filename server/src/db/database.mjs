import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export function createDatabase(filename = process.env.DISKLENS_DB_PATH || "disklens.db") {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");

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

    CREATE INDEX IF NOT EXISTS idx_items_scan_id ON items(scan_id);
    CREATE INDEX IF NOT EXISTS idx_items_root ON items(root);
    CREATE INDEX IF NOT EXISTS idx_items_path ON items(path);
    CREATE INDEX IF NOT EXISTS idx_items_size ON items(type, size DESC);

    CREATE TABLE IF NOT EXISTS drives (
      root TEXT PRIMARY KEY,
      volume_name TEXT,
      file_system TEXT,
      total_bytes INTEGER NOT NULL,
      free_bytes INTEGER NOT NULL,
      used_bytes INTEGER NOT NULL,
      drive_type INTEGER,
      volume_serial_number TEXT,
      updated_at TEXT NOT NULL
    );

    -- New scans are staged separately. The currently visible index is replaced
    -- only after a scan completes successfully, so cancellation/crashes do not
    -- leave the user with a half-indexed drive.
    CREATE TABLE IF NOT EXISTS scan_runs (
      scan_id TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      uploaded_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      total_estimate INTEGER NOT NULL DEFAULT 0,
      progress_updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scan_runs_root ON scan_runs(root, status);

    CREATE TABLE IF NOT EXISTS staged_items (
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
    CREATE INDEX IF NOT EXISTS idx_staged_scan_id ON staged_items(scan_id);
  `);

  // Upgrade databases created before access-state metadata was added. The old
  // standalone migration script is not required for the normal launcher path.
  const itemColumns = new Set(db.pragma("table_info(items)").map((column) => column.name));
  for (const [column, definition] of Object.entries({
    access_status: "TEXT NOT NULL DEFAULT 'accessible'",
    error_code: "TEXT",
  })) {
    if (!itemColumns.has(column)) db.exec(`ALTER TABLE items ADD COLUMN ${column} ${definition}`);
  }

  // Upgrade databases created before progress tracking was added.
  const scanRunColumns = new Set(db.pragma("table_info(scan_runs)").map((column) => column.name));
  for (const [column, definition] of Object.entries({
    scanned_count: "INTEGER NOT NULL DEFAULT 0",
    uploaded_count: "INTEGER NOT NULL DEFAULT 0",
    skipped_count: "INTEGER NOT NULL DEFAULT 0",
    total_estimate: "INTEGER NOT NULL DEFAULT 0",
    progress_updated_at: "TEXT",
  })) {
    if (!scanRunColumns.has(column)) db.exec(`ALTER TABLE scan_runs ADD COLUMN ${column} ${definition}`);
  }

  // A running scan belongs to a previous server process. On restart, discard
  // its staging rows immediately and keep the last completed index intact.
  const stale = db.prepare("SELECT scan_id FROM scan_runs WHERE status = 'running'").all();
  if (stale.length) {
    const removeStaged = db.prepare("DELETE FROM staged_items WHERE scan_id = ?");
    const markInterrupted = db.prepare("UPDATE scan_runs SET status = 'interrupted' WHERE scan_id = ?");
    const cleanup = db.transaction((rows) => {
      for (const row of rows) {
        removeStaged.run(row.scan_id);
        markInterrupted.run(row.scan_id);
      }
    });
    cleanup(stale);
  }

  return db;
}
