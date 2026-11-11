import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { deleteItem, ensureSafeDeletePath } from "../server/src/services/deleteService.mjs";
import { buildProgramCandidates } from "../server/src/services/programAnalysis.mjs";

test("delete guard rejects filesystem roots and operating-system locations", () => {
  assert.throws(() => ensureSafeDeletePath(path.parse(process.cwd()).root), { code: "PROTECTED_PATH" });
  if (process.platform !== "win32") {
    assert.throws(() => ensureSafeDeletePath("/etc/passwd"), { code: "PROTECTED_PATH" });
    assert.doesNotThrow(() => ensureSafeDeletePath(path.join(process.env.HOME || "/tmp", "Downloads", "sample.zip")));
  }
});

test("recycle mode routes to platform trash commands without deleting the selected file", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-trash-route-"));
  const target = path.join(directory, "keep-me.txt");
  await fs.writeFile(target, "preserve this fixture");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const invocations = [];
  const execFileAsync = async (command, args, options) => {
    invocations.push({ command, args, options });
    return { stdout: "", stderr: "" };
  };

  await deleteItem(target, "file", "recycle", { platform: "win32", execFileAsync });
  assert.equal(invocations[0].command, "powershell.exe");
  assert.deepEqual(invocations[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(invocations[0].args[3], /SendToRecycleBin/);
  assert.equal(invocations[0].options.timeout, 15000);
  assert.equal(invocations[0].options.env.DISKLENS_DELETE_PATH, target);
  assert.equal(invocations[0].options.env.DISKLENS_DELETE_TYPE, "file");

  await deleteItem(target, "file", "recycle", { platform: "darwin", execFileAsync });
  assert.equal(invocations[1].command, "osascript");
  assert.equal(invocations[1].args.at(-1), target);
  assert.match(invocations[1].args[1], /tell application "Finder" to delete/);

  await deleteItem(target, "file", "recycle", { platform: "linux", execFileAsync });
  assert.deepEqual(invocations[2].args, ["trash", target]);
  assert.equal(invocations[2].command, "gio");

  assert.equal(await fs.readFile(target, "utf8"), "preserve this fixture");
});

test("Linux recycle mode falls back to trash-put when gio is unavailable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-trash-fallback-"));
  const target = path.join(directory, "keep-me.txt");
  await fs.writeFile(target, "still here");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const commands = [];
  const execFileAsync = async (command, args) => {
    commands.push({ command, args });
    if (command === "gio") {
      const error = new Error("gio not found");
      error.code = "ENOENT";
      throw error;
    }
    return { stdout: "", stderr: "" };
  };

  await deleteItem(target, "file", "recycle", { platform: "linux", execFileAsync });
  assert.deepEqual(commands, [
    { command: "gio", args: ["trash", target] },
    { command: "trash-put", args: [target] },
  ]);
  assert.equal(await fs.readFile(target, "utf8"), "still here");
});

test("program cleanup identifies indexed files under POSIX app bundle paths", () => {
  const result = buildProgramCandidates([
    { id: 1, path: "/Applications/Example.app/Contents/MacOS/Example", name: "Example", type: "file", size: 123 },
  ], { name: "Example", installLocation: "/Applications/Example.app" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].category, "verified");
});

import { normalizeScanRoots, pathsOverlap } from "../server/src/services/scanPaths.mjs";

test("scan roots are deduplicated and nested selections are rejected", () => {
  const roots = normalizeScanRoots(["/var/data", "/var/other", "/var/data"], "linux");
  assert.deepEqual(roots, ["/var/data", "/var/other"]);
  assert.throws(
    () => normalizeScanRoots(["/var/data", "/var/data/photos"], "linux"),
    { code: "SCAN_ROOT_OVERLAP" },
  );
  assert.equal(pathsOverlap("/var/data", "/var/database", "linux"), false);
});

test("scan root normalization follows the host platform path rules", () => {
  const parent = path.join(os.tmpdir(), "disklens-path-test");
  const child = path.join(parent, "child");
  assert.equal(pathsOverlap(parent, child), true);
  assert.equal(pathsOverlap(parent, `${parent}-sibling`), false);
  assert.deepEqual(normalizeScanRoots([parent, parent]), [path.resolve(parent)]);
});

test("Windows scan root comparisons are case-insensitive and boundary-aware", () => {
  assert.equal(pathsOverlap("C:\\Users\\Public", "c:\\users\\public\\Pictures", "win32"), true);
  assert.equal(pathsOverlap("C:\\Users", "C:\\Users2", "win32"), false);
  assert.deepEqual(
    normalizeScanRoots(["C:\\Users", "c:\\users"], "win32"),
    ["C:\\Users"],
  );
});

test("Windows UNC scan roots preserve share boundaries", () => {
  const shareRoot = String.raw`\\server\share`;
  const nested = String.raw`\\server\share\photos`;
  const siblingShare = String.raw`\\server\share2`;
  assert.equal(pathsOverlap(shareRoot, nested, "win32"), true);
  assert.equal(pathsOverlap(shareRoot, siblingShare, "win32"), false);
  assert.deepEqual(normalizeScanRoots([shareRoot, String.raw`\\SERVER\SHARE`], "win32"), [path.win32.resolve(shareRoot)]);
});

import { classifyScanJobRoots } from "../server/src/services/scanJobs.mjs";

test("a cancelled multi-root job marks only prior roots complete and queued roots aborted", () => {
  const outcomes = classifyScanJobRoots({
    id: "job-1",
    roots: ["C:\\", "D:\\", "E:\\"],
    currentRoot: "D:\\",
    completedRoots: new Set(["c:\\"]),
    cancelRequested: true,
    startedAt: "2026-11-11T00:00:00.000Z",
  }, 130, false, "win32");
  assert.deepEqual(outcomes.map((row) => row.status), ["completed", "aborted", "aborted"]);
});

test("a failed multi-root job marks its active root failed and later roots interrupted", () => {
  const outcomes = classifyScanJobRoots({
    id: "job-2",
    roots: ["/mnt/a", "/mnt/b", "/mnt/c"],
    currentRoot: "/mnt/b",
    completedRoots: new Set(["/mnt/a"]),
    cancelRequested: false,
    startedAt: "2026-11-11T00:00:00.000Z",
  }, 1);
  assert.deepEqual(outcomes.map((row) => row.status), ["completed", "failed", "interrupted"]);
});
