import Fastify from "fastify";
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

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: ["http://localhost:8000", "http://127.0.0.1:8000"],
});

const db = createDatabase("disklens.db");

registerHealthRoutes(app);
registerScanRoutes(app, db);
registerItemRoutes(app, db);
registerRootRoutes(app, db);
registerStorageRoutes(app, db);
registerFolderRoutes(app, db);
registerExplorerRoutes(app, db);
registerDeleteRoutes(app, db);
registerProgramRoutes(app, db);
registerAIRoutes(app, db);

app.listen({ host: "127.0.0.1", port: 4000 });
