import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";

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
import { registerCleanupRoutes } from "./routes/cleanup.mjs";
import { registerAppRoutes } from "./routes/app.mjs";
import { installDiskLensOriginPolicy } from "./security/localOrigin.mjs";
import { requireSupportedNodeRuntime } from "../../shared/nodeRuntime.mjs";

requireSupportedNodeRuntime("DiskLens server");

function loadLocalEnv() {
  const envFile = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envFile)) return;
  for (const rawLine of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnv();

const portValue = Number(process.env.DISKLENS_PORT || 4000);
const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 4000;
const dbPath = process.env.DISKLENS_DB_PATH || "disklens.db";
const app = Fastify({
  logger: { level: process.env.DISKLENS_LOG_LEVEL || "info" },
  bodyLimit: 5 * 1024 * 1024,
  requestTimeout: 30_000,
});

await installDiskLensOriginPolicy(app);

const db = createDatabase(dbPath);
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
registerCleanupRoutes(app, db);
registerAppRoutes(app);

app.addHook("onClose", async () => {
  try { db.close(); } catch {}
});

try {
  await app.listen({ host: "127.0.0.1", port });
  app.log.info(`DiskLens API listening on http://127.0.0.1:${port}`);
} catch (error) {
  app.log.error(error, "Could not start DiskLens API");
  process.exitCode = 1;
  try { db.close(); } catch {}
}

async function closeServer(signal) {
  app.log.info({ signal }, "Shutting down DiskLens API");
  try { await app.close(); } catch (error) { app.log.error(error); }
}
process.once("SIGINT", () => closeServer("SIGINT").finally(() => process.exit(130)));
process.once("SIGTERM", () => closeServer("SIGTERM").finally(() => process.exit(0)));
