import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const configuredPath = process.env.DISKLENS_DB_PATH || "disklens.db";
const dbPath = path.resolve(configuredPath);

function printSection(title, value) {
  console.log(`\n${title}`);
  console.log(JSON.stringify(value, null, 2));
}

if (!fs.existsSync(dbPath)) {
  console.error(`Database file not found: ${dbPath}`);
  process.exit(2);
}

const stat = fs.statSync(dbPath);
console.log("DiskLens database diagnostic");
console.log(`Database: ${dbPath}`);
console.log(`File size: ${stat.size.toLocaleString()} bytes`);
console.log(`Last modified: ${stat.mtime.toISOString()}`);

let db;
try {
  // Read-only mode: this script never creates, migrates, or modifies the DB.
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  );
  printSection("Tables", [...tables].sort());

  if (!tables.has("items")) {
    console.error("No items table exists in this database.");
    process.exitCode = 3;
  } else {
    printSection("Item counts", db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN type = 'file' THEN 1 ELSE 0 END) AS files,
        SUM(CASE WHEN type = 'directory' THEN 1 ELSE 0 END) AS folders
      FROM items
    `).get());

    printSection("Indexed roots", db.prepare(`
      SELECT root, COUNT(*) AS items,
        SUM(CASE WHEN type = 'file' THEN size ELSE 0 END) AS fileBytes
      FROM items
      GROUP BY root
      ORDER BY root
    `).all());
  }

  if (tables.has("drives")) {
    printSection("Drive metadata", db.prepare(`
      SELECT root, total_bytes AS totalBytes, free_bytes AS freeBytes, updated_at AS updatedAt
      FROM drives ORDER BY root
    `).all());
  }

  if (tables.has("scan_runs")) {
    printSection("Recent scan runs", db.prepare(`
      SELECT root, status, item_count AS itemCount, started_at AS startedAt, completed_at AS completedAt
      FROM scan_runs
      ORDER BY started_at DESC
      LIMIT 10
    `).all());
  }
} catch (error) {
  console.error(`Could not inspect database: ${error.message}`);
  process.exitCode = 4;
} finally {
  try { db?.close(); } catch {}
}
