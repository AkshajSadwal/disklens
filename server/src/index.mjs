import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";

// Lightweight .env loader: local values are optional and never override shell env.
const envFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\\r?\\n/)) {
    const match = line.match(/^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)\\s*$/);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(['"])(.*)\\1$/, "$2");
    process.env[match[1]] = value;
  }
}
import cors from "@fastify/cors";

import { createDatabase } from "./db/database.mjs";
import { registerHealthRoutes } from "./routes/health.mjs";
import { registerScanRoutes } from "./routes/scans.mjs";
import { registerItemRoutes } from "./routes/items.mjs";
import { registerRootRoutes } from "./routes/roots.mjs";
import { registerStorageRoutes } from "./routes/storage.mjs";
import { registerFolderRoutes } from "./routes/folders.mjs";
import { registerExplorerRoutes } from "./routes/explorer.mjs";
import { registerDeleteRoutes } from "./routes/delete.mjs";
import { registerProgramRoutes } from "./routes/programs.mjs";
import { registerAIRoutes } from "./routes/ai.mjs";
import { registerDriveRoutes } from "./routes/drives.mjs";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin(origin, callback) {
    // The app stays loopback-only, while allowing its dynamically selected UI port.
    const allowed = !origin || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
    callback(null, allowed);
  },
});

const db = createDatabase("disklens.db");

registerHealthRoutes(app);
registerScanRoutes(app, db);
registerItemRoutes(app, db);
registerRootRoutes(app, db);
registerDriveRoutes(app, db);
registerStorageRoutes(app, db);
registerFolderRoutes(app, db);
registerExplorerRoutes(app, db);
registerDeleteRoutes(app, db);
registerProgramRoutes(app, db);
registerAIRoutes(app, db);

app.listen({ host: "127.0.0.1", port: 4000 });
