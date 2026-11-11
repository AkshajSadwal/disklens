import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getUserDataDirectory, prepareUserDataDirectory, runFirstRun } from "./first-run.mjs";
import { buildFrontendDevArgs } from "./frontendCommand.mjs";
import { requireSupportedNodeRuntime } from "../shared/nodeRuntime.mjs";

try {
  requireSupportedNodeRuntime("DiskLens launcher");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let shuttingDown = false;
let npmRunner;
const dataDirectory = getUserDataDirectory();
const dbPath = path.join(dataDirectory, "disklens.db");
const lockPath = path.join(dataDirectory, "launcher.lock");
let lockHandle = null;

async function acquireLauncherLock() {
  await mkdir(dataDirectory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await lockHandle.sync();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing = null;
      try { existing = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
      const pid = Number(existing?.pid);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; }
        catch (probeError) { alive = probeError.code === "EPERM"; }
      }
      if (alive) throw new Error(`DiskLens is already running (PID ${pid}). Close the existing window before starting another instance.`);
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire the DiskLens application lock.");
}

async function releaseLauncherLock() {
  try { await lockHandle?.close(); } catch {}
  lockHandle = null;
  try {
    const existing = JSON.parse(await readFile(lockPath, "utf8"));
    if (Number(existing?.pid) === process.pid) await rm(lockPath, { force: true });
  } catch {}
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 100; port += 1) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => server.close(resolve));
      return port;
    } catch {}
  }
  throw new Error(`No free localhost port found near ${preferred}.`);
}

function npmCommand() {
  if (npmRunner) return npmRunner;
  const binDir = path.dirname(process.execPath);
  const candidates = [
    path.join(binDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find(existsSync);
  npmRunner = cli
    ? { command: process.execPath, prefix: [cli], shell: false }
    : { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: process.platform === "win32" };
  return npmRunner;
}

function spawnManaged(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
  children.add(child);
  child.once("error", (error) => {
    console.error(`Could not start ${command}: ${error.message}`);
    shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && code !== 0) {
      console.error(`${path.basename(command)} stopped unexpectedly (${signal || code}).`);
      shutdown(typeof code === "number" ? code : 1);
    }
  });
  return child;
}

async function runNpm(args, folder) {
  const runner = npmCommand();
  await new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.prefix, ...args], {
      cwd: folder,
      env: process.env,
      stdio: "inherit",
      shell: runner.shell,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} failed in ${folder} (${signal || code}).`)));
  });
}

async function ensureDependencies(folder) {
  const packageJson = path.join(folder, "package.json");
  const nodeModules = path.join(folder, "node_modules");
  if (!existsSync(packageJson)) return;
  const metadata = JSON.parse(await readFile(packageJson, "utf8"));
  const dependencies = Object.keys({ ...(metadata.dependencies || {}), ...(metadata.devDependencies || {}) });
  const installed = dependencies.every((name) => existsSync(path.join(nodeModules, name, "package.json")));
  if (installed) return;
  console.log(`Installing dependencies in ${path.relative(root, folder)}...`);
  const hasLock = existsSync(path.join(folder, "package-lock.json"));
  await runNpm([hasLock ? "ci" : "install", "--no-audit", "--no-fund"], folder);
}

async function waitFor(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError.message})` : ""}`);
}

function openBrowser(url) {
  try {
    let command;
    let args;
    if (process.platform === "win32") {
      command = "cmd.exe";
      args = ["/d", "/s", "/c", `start "" "${url}"`];
    } else if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    const opener = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    opener.once("error", (error) => console.warn(`Could not open the browser automatically: ${error.message}`));
    opener.unref();
  } catch (error) {
    console.warn(`Could not open the browser automatically: ${error.message}`);
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const active = [...children];
  for (const child of active) {
    if (child.exitCode !== null || child.killed) continue;
    try { child.kill("SIGTERM"); } catch {}
  }
  await delay(600);
  if (process.platform === "win32") {
    for (const child of active) {
      if (child.exitCode === null && child.pid) {
        await new Promise((resolve) => {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
          killer.once("exit", resolve);
          killer.once("error", resolve);
        });
      }
    }
  }
  await releaseLauncherLock();
  process.exit(code);
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(0));

try {
  await acquireLauncherLock();
  prepareUserDataDirectory();
  console.log("\nDiskLens — local launcher");
  console.log(`Platform: ${process.platform} (${process.arch}) | Node.js ${process.version}`);
  console.log(`Local data: ${dataDirectory}`);
  const serverDir = path.join(root, "server");
  const frontendDir = path.join(root, "frontend");
  await ensureDependencies(serverDir);
  await ensureDependencies(frontendDir);

  const envFile = path.join(serverDir, ".env");
  if (!existsSync(envFile)) {
    await copyFile(path.join(root, ".env.example"), envFile);
    console.log("Created server/.env. AI keys are optional; local rules work without them.");
  }

  const apiPort = await availablePort(Number(process.env.DISKLENS_PORT || 4000));
  const webPort = await availablePort(Number(process.env.DISKLENS_WEB_PORT || 3000));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const serverEnv = {
    ...process.env,
    DISKLENS_PORT: String(apiPort),
    DISKLENS_WEB_ORIGIN: webUrl,
    DISKLENS_DB_PATH: dbPath,
  };

  spawnManaged(process.execPath, [path.join(serverDir, "src", "index.mjs")], serverDir, serverEnv);
  await waitFor(`${apiUrl}/api/health`);
  console.log(`Backend ready at ${apiUrl}`);

  // Run the explicit-consent first-run folder picker after the API is ready.
  await runFirstRun(apiUrl, dataDirectory);

  const nextBin = path.join(frontendDir, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextBin)) throw new Error("Next.js executable is missing. Re-run the launcher to install frontend dependencies.");
  spawnManaged(process.execPath, buildFrontendDevArgs(nextBin, webPort), frontendDir, {
    ...process.env,
    PORT: String(webPort),
    NEXT_PUBLIC_DISKLENS_API: apiUrl,
  });
  await waitFor(webUrl, 90000);
  console.log(`\nDiskLens ready at ${webUrl}`);
  console.log("Keep this terminal open. Press Ctrl+C to stop DiskLens.");
  openBrowser(webUrl);
} catch (error) {
  console.error(`Launcher failed: ${error.message}`);
  await shutdown(1);
}
