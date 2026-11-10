import Database from "better-sqlite3";

const db = new Database("disklens.db");

try {
  db.exec(`
    ALTER TABLE items
    ADD COLUMN access_status TEXT NOT NULL DEFAULT 'accessible'
  `);
} catch (error) {
  if (!error.message.includes("duplicate column")) {
    throw error;
  }
}

try {
  db.exec(`
    ALTER TABLE items
    ADD COLUMN error_code TEXT
  `);
} catch (error) {
  if (!error.message.includes("duplicate column")) {
    throw error;
  }
}

console.log("Migration complete");

db.close();