import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const execFileAsync = promisify(execFile);
const allowedTypes = new Set(["file", "directory", "symbolic-link", "other"]);
const maxBatchSize = 250;
const maxTextLength = 32768;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function countValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function registerScanRoutes(app, db) {
  const activeScans = new Map();
  const startRun = db.prepare(`
    INSERT INTO scan_runs (scan_id, root, status, started_at, completed_at, item_count)
    VALUES (?, ?, 'running', ?, NULL, 0)
  `);
  const insertStaged = db.prepare(`
    INSERT INTO staged_items (
      scan_id, root, path, name, type, size, created_at, modified_at,
      access_status, error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  app.post("/api/scans/pick", async (request, reply) => {
    try {
      let selected = "";
      if (process.platform === "win32") {
        const script = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a folder for DiskLens to index'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($dialog.SelectedPath)
}
`;
        const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { maxBuffer: 1024 * 1024 });
        selected = stdout.trim();
      } else if (process.platform === "darwin") {
        const script = 'POSIX path of (choose folder with prompt "Choose a folder for DiskLens to index")';
        const { stdout } = await execFileAsync("osascript", ["-e", script]);
        selected = stdout.trim();
      } else {
        try {
          const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Choose a folder for DiskLens to index"]);
          selected = stdout.trim();
        } catch (error) {
          if (error.code === 1) return { cancelled: true };
          if (error.code !== "ENOENT") throw error;
          try {
            const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory", process.env.HOME || "/"]);
            selected = stdout.trim();
          } catch (fallbackError) {
            if (fallbackError.code === 1) return { cancelled: true };
            if (fallbackError.code === "ENOENT") {
              if (!stdin.isTTY || !stdout.isTTY) {
                return reply.code(501).send({ error: "No Linux folder picker is installed. Install zenity or kdialog, or restart DiskLens from a terminal to enter a folder path." });
              }
              const rl = createInterface({ input: stdin, output: stdout });
              try {
                selected = (await rl.question("Enter the absolute folder path to add to DiskLens: ")).trim();
              } finally {
                rl.close();
              }
            } else {
              throw fallbackError;
            }
          }
        }
      }
      if (!selected) return { cancelled: true };
      const root = path.resolve(selected);
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) return reply.code(400).send({ error: "The selected location is not a directory." });
      return { cancelled: false, root };
    } catch (error) {
      // AppleScript returns a non-zero code when the user closes the dialog.
      if (process.platform === "darwin" && error.code === 1) return { cancelled: true };
      request.log.warn({ err: error }, "Native folder picker could not be opened");
      return reply.code(500).send({ error: `Could not open the folder picker: ${error.message}` });
    }
  });

  app.post("/api/scans/run", async (request, reply) => {
    const requestedRoot = typeof request.body?.root === "string" ? request.body.root.trim() : "";
    if (!requestedRoot || requestedRoot.length > maxTextLength) return reply.code(400).send({ error: "A valid scan root is required." });
    const root = path.resolve(requestedRoot);
    let stat;
    try { stat = await fs.stat(root); } catch { return reply.code(400).send({ error: "The selected scan folder is unavailable." }); }
    if (!stat.isDirectory()) return reply.code(400).send({ error: "The selected scan target must be a folder." });

    const knownRoot = db.prepare("SELECT 1 AS ok FROM scan_runs WHERE root = ? LIMIT 1").get(root)
      || db.prepare("SELECT 1 AS ok FROM drives WHERE root = ? LIMIT 1").get(root)
      || db.prepare("SELECT 1 AS ok FROM items WHERE root = ? LIMIT 1").get(root);
    if (!knownRoot && request.body?.addNewRoot !== true) {
      return reply.code(403).send({ error: "Choose Add folder first to add a new location to the DiskLens index." });
    }
    if (activeScans.has(root)) return reply.code(409).send({ error: "This location is already being scanned." });

    const collector = path.join(projectRoot, "collector", "src", "index.mjs");
    const port = Number(process.env.DISKLENS_PORT || 4000);
    const child = spawn(process.execPath, [collector, root], {
      cwd: projectRoot,
      env: { ...process.env, DISKLENS_SERVER: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    activeScans.set(root, child);
    const forwardLines = (stream, level) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) if (line.trim()) app.log[level]({ root }, line.trim());
      });
      stream.on("end", () => { if (pending.trim()) app.log[level]({ root }, pending.trim()); });
    };
    forwardLines(child.stdout, "info");
    forwardLines(child.stderr, "warn");
    child.once("error", (error) => {
      app.log.error({ err: error, root }, "Could not start the collector process");
      activeScans.delete(root);
    });
    child.once("exit", (code, signal) => {
      activeScans.delete(root);
      app.log.info({ root, code, signal }, "Collector process exited");
    });
    return reply.code(202).send({ started: true, root, pid: child.pid || null });
  });

  app.post("/api/scans/cancel", async (request, reply) => {
    const root = typeof request.body?.root === "string" ? path.resolve(request.body.root) : "";
    const child = activeScans.get(root);
    if (!child) return reply.code(404).send({ error: "No active scan was found for this location." });
    try { child.kill("SIGINT"); } catch (error) { return reply.code(500).send({ error: error.message }); }
    return { cancelled: true, root };
  });

  app.get("/api/scans/status", async (request, reply) => {
    const root = typeof request.query?.root === "string" ? request.query.root : "";
    if (root.length > maxTextLength) return reply.code(400).send({ error: "Invalid root." });
    const row = root
      ? db.prepare(`SELECT * FROM scan_runs WHERE root = ? ORDER BY started_at DESC LIMIT 1`).get(root)
      : db.prepare(`SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1`).get();
    if (root && activeScans.has(path.resolve(root)) && (!row || row.status !== "running")) {
      return { scan: { root, status: "starting", scannedCount: 0, uploadedCount: 0, skippedCount: 0, totalEstimate: 0 } };
    }
    if (!row) return { scan: null };
    return {
      scan: {
        scanId: row.scan_id, root: row.root, status: row.status,
        startedAt: row.started_at, completedAt: row.completed_at,
        itemCount: row.item_count, scannedCount: row.scanned_count || 0,
        uploadedCount: row.uploaded_count || 0, skippedCount: row.skipped_count || 0,
        totalEstimate: row.total_estimate || 0,
        progressUpdatedAt: row.progress_updated_at || null,
      },
    };
  });

  app.addHook("onClose", async () => {
    for (const child of activeScans.values()) {
      try { child.kill("SIGINT"); } catch {}
    }
    activeScans.clear();
  });

  app.post("/api/scans", async (request, reply) => {
    const body = request.body ?? {};
    const phase = String(body.phase || "").toLowerCase();
    const root = typeof body.root === "string" ? body.root.trim() : "";
    const scanId = typeof body.scanId === "string" && body.scanId.trim() ? body.scanId.trim() : randomUUID();

    if (!root || root.length > maxTextLength) return reply.code(400).send({ error: "A valid scan root is required." });

    if (phase === "start") {
      const stale = db.prepare("SELECT scan_id FROM scan_runs WHERE root = ? AND status = 'running'").all(root);
      const cleanupStale = db.transaction((rows) => {
        for (const row of rows) {
          db.prepare("DELETE FROM staged_items WHERE scan_id = ?").run(row.scan_id);
          db.prepare("UPDATE scan_runs SET status = 'interrupted' WHERE scan_id = ?").run(row.scan_id);
        }
      });
      cleanupStale(stale);
      try { startRun.run(scanId, root, new Date().toISOString()); }
      catch (error) {
        request.log.error(error);
        return reply.code(409).send({ error: "Could not start this scan session." });
      }
      return { scanId, status: "running" };
    }

    const run = db.prepare("SELECT scan_id, root, status FROM scan_runs WHERE scan_id = ?").get(scanId);
    if (!run || run.root !== root || run.status !== "running") {
      return reply.code(409).send({ error: "Scan session is missing or no longer active." });
    }

    if (phase === "progress") {
      const scanned = countValue(body.scanned);
      const uploaded = countValue(body.uploaded);
      const skipped = countValue(body.skipped);
      const total = countValue(body.total);
      db.prepare(`UPDATE scan_runs SET scanned_count = ?, uploaded_count = ?, skipped_count = ?, total_estimate = ?, progress_updated_at = ? WHERE scan_id = ?`)
        .run(scanned, uploaded, skipped, total, new Date().toISOString(), scanId);
      return { scanId, status: "running" };
    }

    if (phase === "batch") {
      const items = body.items;
      if (!Array.isArray(items) || items.length > maxBatchSize) return reply.code(400).send({ error: `items must contain between 0 and ${maxBatchSize} rows.` });
      for (const item of items) {
        if (!item || typeof item.path !== "string" || typeof item.name !== "string" || !allowedTypes.has(item.type)) {
          return reply.code(400).send({ error: "Each scan item must include path, name, and a supported type." });
        }
        if (item.path.length > maxTextLength || item.name.length > 4096) return reply.code(400).send({ error: "A scan item path or name is too long." });
      }
      const insertBatch = db.transaction((rows) => {
        for (const item of rows) {
          insertStaged.run(
            scanId, root, item.path, item.name, item.type, Math.max(0, Number(item.size) || 0),
            typeof item.createdAt === "string" ? item.createdAt.slice(0, 64) : "",
            typeof item.modifiedAt === "string" ? item.modifiedAt.slice(0, 64) : "",
            typeof item.accessStatus === "string" ? item.accessStatus.slice(0, 64) : "accessible",
            typeof item.errorCode === "string" ? item.errorCode.slice(0, 128) : null,
          );
        }
      });
      insertBatch(items);
      return { scanId, count: items.length };
    }

    if (phase === "complete") {
      const complete = db.transaction(() => {
        const count = db.prepare("SELECT COUNT(*) AS count FROM staged_items WHERE scan_id = ?").get(scanId).count;
        db.prepare("DELETE FROM items WHERE root = ?").run(root);
        db.prepare(`
          INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at, access_status, error_code)
          SELECT scan_id, root, path, name, type, size, created_at, modified_at, access_status, error_code
          FROM staged_items WHERE scan_id = ?
        `).run(scanId);
        db.prepare("DELETE FROM staged_items WHERE scan_id = ?").run(scanId);
        db.prepare(`UPDATE scan_runs SET status = 'completed', completed_at = ?, item_count = ?, scanned_count = ?, uploaded_count = ? WHERE scan_id = ?`)
          .run(new Date().toISOString(), count, count, count, scanId);
        return count;
      });
      const count = complete();
      return { scanId, status: "completed", count };
    }

    if (phase === "abort") {
      db.transaction(() => {
        db.prepare("DELETE FROM staged_items WHERE scan_id = ?").run(scanId);
        db.prepare("UPDATE scan_runs SET status = 'aborted', completed_at = ? WHERE scan_id = ?").run(new Date().toISOString(), scanId);
      })();
      return { scanId, status: "aborted" };
    }

    return reply.code(400).send({ error: "phase must be start, progress, batch, complete, or abort." });
  });
}
