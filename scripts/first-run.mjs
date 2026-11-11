import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function getUserDataDirectory() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "DiskLens");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "DiskLens");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "DiskLens");
}

function suggestedRoots() {
  if (process.platform === "win32") {
    return Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).filter((root) => fs.existsSync(root));
  }
  if (process.platform === "darwin") {
    return [os.homedir(), "/Volumes"].filter((root) => fs.existsSync(root));
  }
  return [os.homedir(), `/media/${os.userInfo().username}`, "/mnt"].filter((root) => fs.existsSync(root));
}

export function prepareUserDataDirectory() {
  const dataDirectory = getUserDataDirectory();
  fs.mkdirSync(dataDirectory, { recursive: true });
  const destination = path.join(dataDirectory, "disklens.db");
  if (fs.existsSync(destination)) return dataDirectory;
  const legacy = path.join(projectRoot, "server", "disklens.db");
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (fs.existsSync(legacy)) {
    fs.copyFileSync(legacy, destination);
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(`${legacy}${suffix}`)) fs.copyFileSync(`${legacy}${suffix}`, `${destination}${suffix}`);
    }
    console.log(`Moved the existing database into your user data folder: ${destination}`);
  }
  return dataDirectory;
}

async function runCollector(roots, apiUrl, dataDirectory) {
  const env = { ...process.env, DISKLENS_SERVER: apiUrl, DISKLENS_DATA_DIR: dataDirectory };
  const collector = path.join(projectRoot, "collector", "src", "index.mjs");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [collector, ...roots], { cwd: projectRoot, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(signal ? `Collector stopped (${signal}).` : `Collector exited with code ${code}.`)));
  });
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return "unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** exponent)).toFixed(exponent >= 3 ? 1 : 0)} ${units[exponent]}`;
}

function printSystemSummary(roots) {
  const packageData = JSON.parse(fs.readFileSync(path.join(projectRoot, "server", "package.json"), "utf8"));
  console.log(`DiskLens v${packageData.version || "development"}`);
  console.log(`System: ${os.type()} ${os.release()} · ${os.platform()} ${os.arch()}`);
  console.log(`Memory: ${formatBytes(os.totalmem())} total`);
  console.log("Installation: runtime detected; application dependencies are prepared by the launcher.");
  if (roots.length) {
    console.log("Available scan locations:");
    for (const root of roots) {
      let free = "unavailable";
      try {
        const stat = fs.statfsSync(root);
        free = formatBytes(Number(stat.bavail ?? stat.bfree) * Number(stat.bsize || stat.frsize || 1));
      } catch {}
      console.log(`  ${root} · ${free} free`);
    }
  }
}

export async function runFirstRun(apiUrl, dataDirectory = getUserDataDirectory()) {
  const marker = path.join(dataDirectory, "first-run.json");
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (fs.existsSync(marker)) return;

  console.log("\nWelcome to DiskLens");
  const suggestions = suggestedRoots();
  printSystemSummary(suggestions);
  console.log("\nDiskLens indexes file and folder metadata locally. It does not upload complete file contents.");
  console.log("Credential stores and private-key files are excluded by the collector.");
  console.log("No location is scanned until you select it and confirm.");
  console.log("\nChoose only the drives or folders you want indexed. This does not scan automatically.");

  if (!stdin.isTTY || !stdout.isTTY) {
    console.log("First-run scan skipped because no interactive terminal is attached. You can scan later from the collector command.");
    fs.writeFileSync(marker, JSON.stringify({ completedAt: new Date().toISOString(), skipped: true }, null, 2));
    return;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const value = await rl.question("Enter absolute paths separated by semicolons (or press Enter to skip): ");
    const roots = [...new Set(value.split(";").map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item)))];
    if (!roots.length) {
      fs.writeFileSync(marker, JSON.stringify({ completedAt: new Date().toISOString(), skipped: true }, null, 2));
      console.log("First scan skipped. You can run one later from DiskLens.");
      return;
    }
    const invalid = roots.filter((root) => {
      try { return !fs.statSync(root).isDirectory(); } catch { return true; }
    });
    if (invalid.length) {
      console.log(`These paths are not accessible directories: ${invalid.join(", ")}`);
      console.log("No scan was started. Reopen DiskLens and try again.");
      return;
    }
    const confirm = await rl.question(`\nIndex ${roots.length} selected location(s)? Type YES to start: `);
    if (confirm.trim().toUpperCase() !== "YES") {
      console.log("Scan cancelled.");
      return;
    }
    try {
      await runCollector(roots, apiUrl, dataDirectory);
      fs.writeFileSync(marker, JSON.stringify({ completedAt: new Date().toISOString(), roots }, null, 2));
    } catch (error) {
      // A failed first scan must not prevent the UI from opening. The marker is
      // intentionally not written, so the setup prompt can be retried later.
      console.error(`Initial scan did not finish: ${error.message}`);
      console.log("DiskLens will still open. You can retry the scan from the app.");
    }
  } finally {
    rl.close();
  }
}
