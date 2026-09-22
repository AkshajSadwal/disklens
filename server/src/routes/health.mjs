export function registerHealthRoutes(app) {
  app.get("/api/health", async () => ({ ok: true }));
}
