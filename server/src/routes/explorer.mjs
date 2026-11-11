import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function revealPath(targetPath, type) {
  if (process.platform === "win32") {
    const args = type === "file" ? [`/select,${targetPath}`] : [targetPath];
    await execFileAsync("explorer.exe", args, { windowsHide: true, timeout: 10000 });
    return;
  }
  if (process.platform === "darwin") {
    await execFileAsync("open", type === "file" ? ["-R", targetPath] : [targetPath], { timeout: 10000 });
    return;
  }
  const folder = type === "file" ? path.dirname(targetPath) : targetPath;
  await execFileAsync("xdg-open", [folder], { timeout: 10000 });
}

export function registerExplorerRoutes(app, db) {
  app.post("/api/items/:id/open", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid id" });
    const item = db.prepare("SELECT id, path, type FROM items WHERE id = ?").get(id);
    if (!item) return reply.code(404).send({ error: "Item not found" });
    try {
      await revealPath(item.path, item.type === "file" ? "file" : "directory");
      return { ok: true };
    } catch (error) {
      request.log.warn({ error }, "Could not reveal item in the system file manager");
      return reply.code(500).send({ error: `Could not open the system file manager: ${error.message}` });
    }
  });

  app.post("/api/items/:id/open-folder", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "Invalid id" });
    const item = db.prepare("SELECT id, path, type FROM items WHERE id = ?").get(id);
    if (!item) return reply.code(404).send({ error: "Item not found" });
    const folderPath = item.type === "directory" ? item.path : path.dirname(item.path);
    try {
      await revealPath(folderPath, "directory");
      return { ok: true };
    } catch (error) {
      request.log.warn({ error }, "Could not open parent folder");
      return reply.code(500).send({ error: `Could not open the parent folder: ${error.message}` });
    }
  });
}
