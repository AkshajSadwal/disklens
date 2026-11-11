import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function unusedLoopbackPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error("Timed out waiting for the scan to complete.");
}

test("live localhost API scans two small roots and reports a repeated snapshot", { timeout: 20000 }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-scan-integration-"));
  const rootA = path.join(temporary, "scan one café");
  const rootB = path.join(temporary, "scan two");
  const dbPath = path.join(temporary, "integration.sqlite");
  const configPath = path.join(temporary, "config");
  await fs.mkdir(path.join(rootA, "sub folder"), { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  await fs.writeFile(path.join(rootA, "sub folder", "résumé.txt"), "small fixture");
  await fs.writeFile(path.join(rootA, "root-file.txt"), "fixture");
  await fs.writeFile(path.join(rootB, "one.txt"), "1");
  await fs.writeFile(path.join(rootB, "two.txt"), "22");
  const port = await unusedLoopbackPort();
  const server = spawn(process.execPath, ["src/index.mjs"], {
    cwd: path.join(workspace, "server"),
    env: {
      ...process.env,
      DISKLENS_PORT: String(port),
      DISKLENS_DB_PATH: dbPath,
      DISKLENS_CONFIG_DIR: configPath,
      DISKLENS_LOG_LEVEL: "error",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      AZURE_OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let serverError = "";
  server.stderr.setEncoding("utf8").on("data", (chunk) => { serverError += chunk; });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await fs.rm(temporary, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const getJson = async (url) => {
    const response = await fetch(`${base}${url}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  };
  const postJson = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { status: response.status, data };
  };

  try {
    await waitFor(async () => (await getJson("/api/health")).ok);
    const started = await postJson("/api/scans/run", { roots: [rootA, rootB], addNewRoot: true });
    assert.equal(started.status, 202);
    const waitForRoot = (root) => waitFor(async () => {
      const { scan } = await getJson(`/api/scans/status?root=${encodeURIComponent(root)}`);
      if (scan?.status === "failed" || scan?.status === "interrupted" || scan?.status === "aborted") {
        throw new Error(`Scan ${scan.status} for ${root}: ${serverError}`);
      }
      return scan?.status === "completed" ? scan : null;
    });
    await Promise.all([waitForRoot(rootA), waitForRoot(rootB)]);

    const historyA = await getJson(`/api/scans/history?root=${encodeURIComponent(rootA)}`);
    const historyB = await getJson(`/api/scans/history?root=${encodeURIComponent(rootB)}`);
    assert.equal(historyA.runs[0].itemCount, 3);
    assert.equal(historyB.runs[0].itemCount, 2);
    assert.equal(historyA.runs[0].fingerprintMatchesPrevious, null);
    assert.equal(historyB.runs[0].fingerprintMatchesPrevious, null);

    const repeat = await postJson("/api/scans/run", { root: rootA });
    assert.equal(repeat.status, 202);
    await waitForRoot(rootA);
    const repeatedHistory = await getJson(`/api/scans/history?root=${encodeURIComponent(rootA)}`);
    assert.equal(repeatedHistory.runs[0].fingerprintMatchesPrevious, true);
  } catch (error) {
    if (serverError) error.message += `\nServer error output: ${serverError}`;
    throw error;
  }
});
