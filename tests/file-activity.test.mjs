import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkFilesystemActivity } from "../server/src/services/fileActivity.mjs";

test("file activity check reports unsupported platforms without invoking platform tools", async () => {
  const result = await checkFilesystemActivity([], { platform: "linux" });
  assert.equal(result.status, "unsupported");
  assert.equal(result.checkedPaths, 0);
});

test("Windows Restart Manager reports a file held open by another process", { skip: process.platform !== "win32", timeout: 10000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-file-activity-"));
  const file = path.join(directory, "locked fixture.txt");
  await fs.writeFile(file, "short test content");
  const script = "$target=[Console]::In.ReadLine(); $stream=[System.IO.File]::Open($target,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); [Console]::Out.WriteLine('READY'); [Console]::In.ReadLine() | Out-Null; $stream.Dispose()";
  const locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  locker.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  locker.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (locker.exitCode === null && locker.signalCode === null) {
      locker.stdin.write("release\n");
      locker.kill();
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  locker.stdin.write(`${file}\n`);
  const deadline = Date.now() + 4000;
  while (!stdout.includes("READY") && Date.now() < deadline && locker.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(stdout.includes("READY"), stderr || "The test file could not be locked.");

  const result = await checkFilesystemActivity([{ path: file, type: "file" }]);
  assert.equal(result.status, "in-use", result.message);
  assert.ok(result.processIds.includes(locker.pid), `expected lock owner ${locker.pid}, got ${result.processIds.join(", ")}`);
  locker.stdin.write("release\n");
  await new Promise((resolve) => locker.once("exit", resolve));
  assert.equal((await checkFilesystemActivity([{ path: file, type: "file" }])).status, "clear");
});
