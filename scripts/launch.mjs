import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let shuttingDown = false;

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 100; port++) {
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

function run(args, cwd, env) {
  const child = spawn(npm, args, { cwd, env, stdio: "inherit" });
  children.push(child);
  child.once("error", (error) => {
    console.error(error.message);
    shutdown(1);
  });
  child.once("exit", (code) => {
    if (!shuttingDown && code && code !== 0) shutdown(code);
  });
  return child;
}

async function ensureDependencies(folder) {
  if (existsSync(path.join(folder, "node_modules"))) return;
  console.log(`Installing dependencies in ${path.relative(root, folder)}...`);
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ["install"], { cwd: folder, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`npm install failed in ${folder}`)));
  });
}

async function waitFor(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(350);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd"
    : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  await delay(250);
  process.exit(code);
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(0));

try {
  console.log("\nDiskLens — local launcher");
  console.log(`Platform: ${process.platform} (${process.arch}) | Node.js ${process.version}`);
  const serverDir = path.join(root, "server");
  const frontendDir = path.join(root, "frontend");
  const collectorDir = path.join(root, "collector");
  for (const folder of [serverDir, frontendDir, collectorDir]) await ensureDependencies(folder);

  const envFile = path.join(serverDir, ".env");
  if (!existsSync(envFile)) {
    await copyFile(path.join(root, ".env.example"), envFile);
    console.log("Created server/.env. AI keys are optional; local rules work without them.");
  }

  const apiPort = await availablePort(Number(process.env.DISKLENS_PORT || 4000));
  const webPort = await availablePort(8000);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  run(["start"], serverDir, { ...process.env, DISKLENS_PORT: String(apiPort) });
  await waitFor(`${apiUrl}/api/health`);
  console.log(`Backend ready at ${apiUrl}`);

  run(["run", "dev"], frontendDir, {
    ...process.env,
    PORT: String(webPort),
    NEXT_PUBLIC_DISKLENS_API: apiUrl,
  });
  await waitFor(webUrl, 90000);
  console.log(`DiskLens ready at ${webUrl}`);
  openBrowser(webUrl);
  console.log("Press Ctrl+C to stop DiskLens.");
} catch (error) {
  console.error(`Launcher failed: ${error.message}`);
  await shutdown(1);
}
