import { createDatabase } from "../src/db/database.mjs";

const db = createDatabase(process.env.DISKLENS_DB_PATH || "disklens.db");
console.log("DiskLens database migrations complete.");
db.close();
