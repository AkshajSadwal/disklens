import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { canonicalScanPath, normalizeScanRoots, pathsOverlap } from "../services/scanPaths.mjs";
import { classifyScanJobRoots } from "../services/scanJobs.mjs";
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
  // Each scan job may contain several roots that the collector processes in order.
  // Every root points to the same job so cancellation always stops the full batch.
  const activeScans = new Map();
  // Preserve the just-finished job's result briefly so queued roots cannot be
  // mistaken for old successful scans from a previous run.
  const recentScanOutcomes = new Map();
  const pathKey = (value) => canonicalScanPath(value);
  function rememberJobOutcome(job, exitCode, spawnFailed = false) {
    for (const outcome of classifyScanJobRoots(job, exitCode, spawnFailed)) {
      recentScanOutcomes.set(pathKey(outcome.root), outcome);
    }
    while (recentScanOutcomes.size > 500) recentScanOutcomes.delete(recentScanOutcomes.keys().next().value);
  }
  function cleanupUnfinished(job, finalStatus) {
    const rows = db.prepare("SELECT scan_id FROM scan_runs WHERE status = 'running' AND root = ?");
    const clean = db.transaction((root) => {
      for (const row of rows.all(root)) {
        db.prepare("DELETE FROM staged_items WHERE scan_id = ?").run(row.scan_id);
        db.prepare("UPDATE scan_runs SET status = ?, completed_at = ? WHERE scan_id = ?")
          .run(finalStatus, new Date().toISOString(), row.scan_id);
      }
    });
    for (const root of job.roots) clean(root);
  }
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
    const requested = Array.isArray(request.body?.roots)
      ? request.body.roots
      : [request.body?.root];
    if (requested.length > 25 || requested.some((value) => typeof value === "string" && value.length > maxTextLength)) {
      return reply.code(400).send({ error: "Choose between 1 and 25 valid scan locations." });
    }

    let roots;
    try {
      roots = normalizeScanRoots(requested);
    } catch (error) {
      return reply.code(400).send({ error: error.message, code: error.code, roots: error.roots || [] });
    }
    if (!roots.length) return reply.code(400).send({ error: "Choose at least one scan location." });

    for (const root of roots) {
      let stat;
      try { stat = await fs.lstat(root); } catch { return reply.code(400).send({ error: `The selected scan folder is unavailable: ${root}` }); }
      if (stat.isSymbolicLink()) return reply.code(400).send({ error: `Scan target cannot be a symbolic link: ${root}` });
      if (!stat.isDirectory()) return reply.code(400).send({ error: `The selected scan target must be a folder: ${root}` });
      const knownRoot = db.prepare("SELECT 1 AS ok FROM scan_runs WHERE root = ? LIMIT 1").get(root)
        || db.prepare("SELECT 1 AS ok FROM drives WHERE root = ? LIMIT 1").get(root)
        || db.prepare("SELECT 1 AS ok FROM items WHERE root = ? LIMIT 1").get(root);
      if (!knownRoot && request.body?.addNewRoot !== true) {
        return reply.code(403).send({ error: `Choose Add folder first to add ${root} to the DiskLens index.` });
      }
      const conflictingJob = [...new Set(activeScans.values())].find((job) => job.roots.some((activeRoot) => pathsOverlap(activeRoot, root)));
      if (conflictingJob) return reply.code(409).send({ error: `${root} overlaps an already active scan location.` });
    }

    for (const root of roots) recentScanOutcomes.delete(pathKey(root));

    const collector = path.join(projectRoot, "collector", "src", "index.mjs");
    const port = Number(process.env.DISKLENS_PORT || 4000);
    const child = spawn(process.execPath, [collector, ...roots], {
      cwd: projectRoot,
      env: { ...process.env, DISKLENS_SERVER: `http://127.0.0.1:${port}` },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const job = { id: randomUUID(), child, roots, currentRoot: null, cancelRequested: false, completedRoots: new Set(), startedAt: new Date().toISOString() };
    child.stdin?.on("error", (error) => {
      app.log.warn({ err: error, roots }, "Collector control pipe closed unexpectedly");
    });
    for (const root of roots) activeScans.set(pathKey(root), job);

    const forwardLines = (stream, level) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const marker = line.match(/^DISKLENS_SCAN_START:(.+)$/);
          if (marker) {
            try { job.currentRoot = JSON.parse(marker[1]); } catch {}
            continue;
          }
          const completed = line.match(/^DISKLENS_SCAN_COMPLETE:(.+)$/);
          if (completed) {
            try { job.completedRoots.add(JSON.parse(completed[1])); } catch {}
            continue;
          }
          app.log[level]({ root: job.currentRoot || roots[0] }, line.trim());
        }
      });
      stream.on("end", () => { if (pending.trim()) app.log[level]({ root: job.currentRoot || roots[0] }, pending.trim()); });
    };
    forwardLines(child.stdout, "info");
    forwardLines(child.stderr, "warn");
    child.once("error", (error) => {
      app.log.error({ err: error, roots }, "Could not start the collector process");
      cleanupUnfinished(job, "failed");
      rememberJobOutcome(job, null, true);
      for (const root of roots) if (activeScans.get(pathKey(root)) === job) activeScans.delete(pathKey(root));
    });
    child.once("exit", (code, signal) => {
      if (job.cancelRequested || code !== 0) cleanupUnfinished(job, job.cancelRequested ? "aborted" : "interrupted");
      rememberJobOutcome(job, code);
      for (const root of roots) if (activeScans.get(pathKey(root)) === job) activeScans.delete(pathKey(root));
      app.log.info({ roots, code, signal, cancelled: job.cancelRequested }, "Collector process exited");
    });
    return reply.code(202).send({ started: true, jobId: job.id, roots, pid: child.pid || null });
  });

  app.post("/api/scans/cancel", async (request, reply) => {
    const requested = Array.isArray(request.body?.roots) ? request.body.roots : [request.body?.root];
    const jobs = new Set(requested.filter((value) => typeof value === "string" && value.trim())
      .map((root) => activeScans.get(pathKey(root))).filter(Boolean));
    if (!jobs.size) return reply.code(404).send({ error: "No active scan was found for these locations." });
    for (const job of jobs) {
      job.cancelRequested = true;
      try {
        if (job.child.stdin && !job.child.stdin.destroyed && job.child.stdin.writable) {
          job.child.stdin.write("cancel\n");
          job.child.stdin.end();
        } else {
          job.child.kill("SIGTERM");
        }
      } catch (error) {
        request.log.warn({ err: error }, "Could not send graceful scan cancellation");
        try { job.child.kill("SIGTERM"); } catch {}
      }
    }
    return { cancelled: true, roots: [...new Set([...jobs].flatMap((job) => job.roots))] };
  });

  app.get("/api/scans/history", async (request, reply) => {
    const root = typeof request.query?.root === "string" ? request.query.root : "";
    const rawLimit = request.query?.limit;
    if (root.length > maxTextLength) return reply.code(400).send({ error: "Invalid root." });
    if (rawLimit !== undefined && !/^\d+$/.test(String(rawLimit))) return reply.code(400).send({ error: "limit must be a positive integer." });
    const limit = Math.min(100, Math.max(1, Number.parseInt(rawLimit, 10) || 20));
    const rows = root
      ? db.prepare(`SELECT * FROM scan_runs WHERE root = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(root, limit)
      : db.prepare(`SELECT * FROM scan_runs ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(limit);
    return {
      runs: rows.map((row) => ({
        scanId: row.scan_id, root: row.root, status: row.status,
        startedAt: row.started_at, completedAt: row.completed_at,
        itemCount: Number(row.item_count) || 0,
        indexedBytes: Number(row.indexed_bytes) || 0,
        addedCount: Number(row.added_count) || 0,
        changedCount: Number(row.changed_count) || 0,
        unchangedCount: Number(row.unchanged_count) || 0,
        removedCount: Number(row.removed_count) || 0,
        preservedCount: Number(row.preserved_count) || 0,
        scannedCount: Number(row.scanned_count) || 0,
        uploadedCount: Number(row.uploaded_count) || 0,
        skippedCount: Number(row.skipped_count) || 0,
        totalEstimate: Number(row.total_estimate) || 0,
        fingerprintMatchesPrevious: row.fingerprint_matches_previous == null ? null : Boolean(row.fingerprint_matches_previous),
      })),
    };
  });

  app.get("/api/scans/status", async (request, reply) => {
    const root = typeof request.query?.root === "string" ? request.query.root : "";
    if (root.length > maxTextLength) return reply.code(400).send({ error: "Invalid root." });
    const row = root
      ? db.prepare(`SELECT * FROM scan_runs WHERE root = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(root)
      : db.prepare(`SELECT * FROM scan_runs ORDER BY started_at DESC, rowid DESC LIMIT 1`).get();
    const job = root ? activeScans.get(pathKey(root)) : null;
    const recentOutcome = root ? recentScanOutcomes.get(pathKey(root)) : null;
    if (recentOutcome && (!row || !row.started_at || row.started_at < recentOutcome.startedAt)) {
      return { scan: { root: recentOutcome.root, status: recentOutcome.status, scannedCount: 0, uploadedCount: 0, skippedCount: 0, totalEstimate: 0, completedAt: null } };
    }
    if (job && row?.status === "completed" && row.started_at >= job.startedAt) {
      job.completedRoots.add(path.resolve(root));
    }
    if (job?.cancelRequested) {
      if (row?.status === "running") {
        return { scan: { scanId: row.scan_id, root: row.root, status: "cancelling", startedAt: row.started_at,
          scannedCount: row.scanned_count || 0, uploadedCount: row.uploaded_count || 0,
          skippedCount: row.skipped_count || 0, totalEstimate: row.total_estimate || 0 } };
      }
      if (!job.completedRoots.has(path.resolve(root))) {
        return { scan: { root, status: "aborted", scannedCount: 0, uploadedCount: 0, skippedCount: 0, totalEstimate: 0 } };
      }
    }
    if (job && (!row || row.status !== "running") && !job.completedRoots.has(path.resolve(root))) {
      return { scan: { root, status: "starting", scannedCount: 0, uploadedCount: 0, skippedCount: 0, totalEstimate: 0 } };
    }
    if (!row) return { scan: null };
    return {
      scan: {
        scanId: row.scan_id, root: row.root, status: row.status,
        startedAt: row.started_at, completedAt: row.completed_at,
        itemCount: row.item_count, indexedBytes: row.indexed_bytes || 0, scannedCount: row.scanned_count || 0,
        addedCount: row.added_count || 0, changedCount: row.changed_count || 0,
        unchangedCount: row.unchanged_count || 0, removedCount: row.removed_count || 0,
        preservedCount: row.preserved_count || 0,
        uploadedCount: row.uploaded_count || 0, skippedCount: row.skipped_count || 0,
        totalEstimate: row.total_estimate || 0,
        fingerprintMatchesPrevious: row.fingerprint_matches_previous == null ? null : Boolean(row.fingerprint_matches_previous),
        progressUpdatedAt: row.progress_updated_at || null,
      },
    };
  });

  app.addHook("onClose", async () => {
    const jobs = [...new Set(activeScans.values())];
    const waitForExit = (child, timeoutMs) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("error", onError);
    });

    for (const job of jobs) {
      job.cancelRequested = true;
      try {
        if (job.child.stdin && !job.child.stdin.destroyed && job.child.stdin.writable) {
          job.child.stdin.write("cancel\n");
          job.child.stdin.end();
        } else {
          job.child.kill("SIGTERM");
        }
      } catch {
        try { job.child.kill("SIGTERM"); } catch {}
      }
    }

    // Let the collector stop gracefully before the database is closed. If it
    // cannot exit, terminate it and directly discard staging rows while SQLite
    // is still available. The last completed index is never replaced here.
    for (const job of jobs) {
      let exited = await waitForExit(job.child, 8000);
      if (!exited) {
        try { job.child.kill("SIGTERM"); } catch {}
        exited = await waitForExit(job.child, 2000);
      }
      cleanupUnfinished(job, "aborted");
      rememberJobOutcome(job, null);
      for (const root of job.roots) {
        if (activeScans.get(pathKey(root)) === job) activeScans.delete(pathKey(root));
      }
      if (!exited) app.log.error({ roots: job.roots }, "Collector did not exit before database shutdown");
    }
  });

  app.post("/api/scans", async (request, reply) => {
    const body = request.body ?? {};
    const phase = String(body.phase || "").toLowerCase();
    const root = typeof body.root === "string" ? body.root.trim() : "";
    const scanId = typeof body.scanId === "string" && body.scanId.trim() ? body.scanId.trim() : randomUUID();

    if (!root || root.length > maxTextLength) return reply.code(400).send({ error: "A valid scan root is required." });

    if (phase === "start") {
      const previousItemCount = Number(db.prepare("SELECT COUNT(*) AS count FROM items WHERE root = ?").get(root)?.count) || 0;
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
      return { scanId, status: "running", previousItemCount };
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

    if (phase === "access") {
      const itemPath = typeof body.path === "string" ? body.path : "";
      const accessStatus = String(body.accessStatus || "");
      if (!itemPath || itemPath.length > maxTextLength || !["denied", "metadata-unavailable"].includes(accessStatus)) {
        return reply.code(400).send({ error: "A valid inaccessible directory record is required." });
      }
      const result = db.prepare(`
        UPDATE staged_items SET access_status = ?, error_code = ?
        WHERE scan_id = ? AND root = ? AND path = ? AND type = 'directory'
      `).run(accessStatus, typeof body.errorCode === "string" ? body.errorCode.slice(0, 128) : "ACCESS_DENIED", scanId, root, itemPath);
      if (result.changes !== 1) return reply.code(409).send({ error: "The staged directory record is no longer available." });
      return { scanId, path: itemPath, accessStatus };
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
        const hasInaccessibleEntries = Boolean(db.prepare(`
          SELECT 1 FROM staged_items WHERE scan_id = ? AND root = ? AND access_status != 'accessible' LIMIT 1
        `).get(scanId, root));
        let rootFingerprint = null;
        if (!hasInaccessibleEntries) {
          const fingerprintHash = createHash("sha256");
          const fingerprintRows = db.prepare(`
            SELECT path, name, type, size, created_at, modified_at
            FROM staged_items WHERE scan_id = ? AND root = ? ORDER BY path COLLATE BINARY
          `).iterate(scanId, root);
          for (const item of fingerprintRows) {
            // JSON array framing preserves field boundaries and escapes arbitrary
            // path characters; the digest never contains the indexed paths.
            fingerprintHash.update(JSON.stringify([
              item.path, item.name, item.type, item.size, item.created_at, item.modified_at,
            ]));
            fingerprintHash.update("\n");
          }
          rootFingerprint = fingerprintHash.digest("hex");
        }
        const previousFingerprint = db.prepare(`
          SELECT root_fingerprint FROM scan_runs
          WHERE root = ? AND status = 'completed'
          ORDER BY rowid DESC LIMIT 1
        `).get(root)?.root_fingerprint || null;
        const fingerprintMatchesPrevious = rootFingerprint == null || previousFingerprint == null
          ? null
          : Number(previousFingerprint === rootFingerprint);
        const scannedCount = db.prepare("SELECT COUNT(*) AS count FROM staged_items WHERE scan_id = ?").get(scanId).count;
        // A matching fingerprint proves the current accessible snapshot is
        // identical to the most recent complete snapshot. In that case the
        // indexed data fields already contain exactly these entries, so skip
        // the expensive diff and correlated update/insert/delete queries.
        const unchangedSnapshot = fingerprintMatchesPrevious === 1;
        const diff = unchangedSnapshot
          ? { addedCount: 0, changedCount: 0, unchangedCount: scannedCount }
          : db.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN old.id IS NULL THEN 1 ELSE 0 END), 0) AS addedCount,
            COALESCE(SUM(CASE WHEN old.id IS NOT NULL AND (
              old.name IS NOT current.name OR old.type IS NOT current.type OR old.size IS NOT current.size
              OR old.created_at IS NOT current.created_at OR old.modified_at IS NOT current.modified_at
              OR old.access_status IS NOT current.access_status OR old.error_code IS NOT current.error_code
            ) THEN 1 ELSE 0 END), 0) AS changedCount,
            COALESCE(SUM(CASE WHEN old.id IS NOT NULL AND NOT (
              old.name IS NOT current.name OR old.type IS NOT current.type OR old.size IS NOT current.size
              OR old.created_at IS NOT current.created_at OR old.modified_at IS NOT current.modified_at
              OR old.access_status IS NOT current.access_status OR old.error_code IS NOT current.error_code
            ) THEN 1 ELSE 0 END), 0) AS unchangedCount
          FROM staged_items AS current
          LEFT JOIN items AS old ON old.root = current.root AND old.path = current.path
          WHERE current.scan_id = ? AND current.root = ?
        `).get(scanId, root);
        const removedCount = unchangedSnapshot ? 0 : db.prepare(`
          SELECT COUNT(*) AS count FROM items AS old
          WHERE old.root = ?
            AND NOT EXISTS (SELECT 1 FROM staged_items AS current WHERE current.scan_id = ? AND current.root = old.root AND current.path = old.path)
            AND NOT EXISTS (
              SELECT 1 FROM staged_items AS denied WHERE denied.scan_id = ? AND denied.root = old.root
                AND denied.type = 'directory' AND denied.access_status != 'accessible'
                AND substr(old.path, 1, length(denied.path) + 1) = denied.path || ?
            )
        `).get(root, scanId, scanId, path.sep).count;
        const preservedCount = unchangedSnapshot ? 0 : db.prepare(`
          SELECT COUNT(*) AS count FROM items AS old
          WHERE old.root = ?
            AND NOT EXISTS (SELECT 1 FROM staged_items AS current WHERE current.scan_id = ? AND current.root = old.root AND current.path = old.path)
            AND EXISTS (
              SELECT 1 FROM staged_items AS denied WHERE denied.scan_id = ? AND denied.root = old.root
                AND denied.type = 'directory' AND denied.access_status != 'accessible'
                AND substr(old.path, 1, length(denied.path) + 1) = denied.path || ?
            )
        `).get(root, scanId, scanId, path.sep).count;
        // Keep old entries underneath a directory the collector could not read.
        // For accessible areas, remove deleted paths and update only changed rows.
        if (!unchangedSnapshot) {
          db.prepare(`
          DELETE FROM items
          WHERE root = ?
            AND NOT EXISTS (
              SELECT 1 FROM staged_items AS current
              WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path
            )
            AND NOT EXISTS (
              SELECT 1 FROM staged_items AS denied
              WHERE denied.scan_id = ? AND denied.root = items.root
                AND denied.type = 'directory' AND denied.access_status != 'accessible'
                AND substr(items.path, 1, length(denied.path) + 1) = denied.path || ?
            )
          `).run(root, scanId, scanId, path.sep);

          db.prepare(`
          UPDATE items SET
            scan_id = (SELECT current.scan_id FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path),
            name = (SELECT current.name FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path),
            type = (SELECT current.type FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path),
            size = (SELECT current.size FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path),
            created_at = (SELECT current.created_at FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path),
            modified_at = (SELECT current.modified_at FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path),
            access_status = (SELECT current.access_status FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path),
            error_code = (SELECT current.error_code FROM staged_items AS current WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path)
          WHERE items.root = ? AND EXISTS (
            SELECT 1 FROM staged_items AS current
            WHERE current.scan_id = ? AND current.root = items.root AND current.path = items.path
              AND (items.name IS NOT current.name OR items.type IS NOT current.type OR items.size IS NOT current.size
                OR items.created_at IS NOT current.created_at OR items.modified_at IS NOT current.modified_at
                OR items.access_status IS NOT current.access_status OR items.error_code IS NOT current.error_code)
          )
          `).run(scanId, scanId, scanId, scanId, scanId, scanId, scanId, scanId, root, scanId);

          db.prepare(`
          INSERT INTO items (scan_id, root, path, name, type, size, created_at, modified_at, access_status, error_code)
          SELECT scan_id, root, path, name, type, size, created_at, modified_at, access_status, error_code
          FROM staged_items AS fresh WHERE fresh.scan_id = ?
            AND NOT EXISTS (SELECT 1 FROM items WHERE items.root = fresh.root AND items.path = fresh.path)
          `).run(scanId);
        } else {
          // Keep the row's source scan current without running the full
          // metadata reconciliation used for changed snapshots.
          db.prepare("UPDATE items SET scan_id = ? WHERE root = ? AND scan_id IS NOT ?")
            .run(scanId, root, scanId);
        }
        db.prepare("DELETE FROM staged_items WHERE scan_id = ?").run(scanId);
        const summary = db.prepare(`
          SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN type = 'file' THEN size ELSE 0 END), 0) AS indexedBytes
          FROM items WHERE root = ?
        `).get(root);
        db.prepare(`UPDATE scan_runs SET status = 'completed', completed_at = ?, item_count = ?, indexed_bytes = ?,
          added_count = ?, changed_count = ?, unchanged_count = ?, removed_count = ?, preserved_count = ?, scanned_count = ?, uploaded_count = ?,
          root_fingerprint = ?, fingerprint_matches_previous = ? WHERE scan_id = ?`)
          .run(new Date().toISOString(), summary.count, summary.indexedBytes, diff.addedCount, diff.changedCount,
            diff.unchangedCount, removedCount, preservedCount, scannedCount, scannedCount,
            rootFingerprint, fingerprintMatchesPrevious, scanId);
        return { count: summary.count, indexedBytes: Number(summary.indexedBytes) || 0, ...diff, removedCount, preservedCount,
          fingerprintMatchesPrevious: fingerprintMatchesPrevious == null ? null : Boolean(fingerprintMatchesPrevious) };
      });
      const summary = complete();
      return { scanId, status: "completed", ...summary };
    }

    if (phase === "abort") {
      db.transaction(() => {
        db.prepare("DELETE FROM staged_items WHERE scan_id = ?").run(scanId);
        db.prepare("UPDATE scan_runs SET status = 'aborted', completed_at = ? WHERE scan_id = ?").run(new Date().toISOString(), scanId);
      })();
      return { scanId, status: "aborted" };
    }

    return reply.code(400).send({ error: "phase must be start, progress, access, batch, complete, or abort." });
  });
}
