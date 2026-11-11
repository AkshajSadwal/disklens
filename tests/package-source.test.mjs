import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSourcePackage } from "../scripts/package-source.mjs";

const execFileAsync = promisify(execFile);

test("source package includes app sources but excludes secrets, databases, dependencies, and build output", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-package-test-"));
  const sourceRoot = path.join(temporary, "source");
  const outputDirectory = path.join(temporary, "release-output");
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const relative of ["server", "server/src", "frontend/.next/cache", "node_modules/example", ".ssh"]) {
    await fs.mkdir(path.join(sourceRoot, relative), { recursive: true });
  }
  await Promise.all([
    fs.writeFile(path.join(sourceRoot, "README.md"), "source readme"),
    fs.writeFile(path.join(sourceRoot, ".env.example"), "OPENAI_API_KEY="),
    fs.writeFile(path.join(sourceRoot, ".env"), "OPENAI_API_KEY=private"),
    fs.writeFile(path.join(sourceRoot, "server/package.json"), '{"version":"1.0.0"}'),
    fs.writeFile(path.join(sourceRoot, "server/src/main.mjs"), "export {};"),
    fs.writeFile(path.join(sourceRoot, "server/disklens.db"), "database fixture"),
    fs.writeFile(path.join(sourceRoot, "server/disklens.db-wal"), "wal fixture"),
    fs.writeFile(path.join(sourceRoot, "server/ai-key.local.enc"), "encrypted fixture"),
    fs.writeFile(path.join(sourceRoot, "node_modules/example/index.js"), "dependency"),
    fs.writeFile(path.join(sourceRoot, "frontend/.next/cache/build.js"), "build cache"),
    fs.writeFile(path.join(sourceRoot, ".ssh/id_ed25519"), "private key fixture"),
  ]);

  const result = await createSourcePackage({ sourceRoot, outputDirectory, version: "1.0.0", tag: "v1.0.0" });
  assert.equal(result.fileCount, 4);
  const { stdout } = await execFileAsync("tar", ["-tzf", result.archive], { windowsHide: true });
  const members = stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(members.includes("DiskLens-1.0.0/README.md"));
  assert.ok(members.includes("DiskLens-1.0.0/.env.example"));
  assert.ok(members.includes("DiskLens-1.0.0/server/package.json"));
  assert.ok(members.includes("DiskLens-1.0.0/server/src/main.mjs"));
  assert.equal(members.some((name) => /(?:^|\/)(?:\.env$|disklens\.db|node_modules|\.next|id_ed25519|ai-key\.local\.enc)/i.test(name)), false);
  await assert.rejects(createSourcePackage({ sourceRoot, outputDirectory, version: "1.0.0", tag: "v2.0.0" }), /does not match/);
  await assert.rejects(createSourcePackage({ sourceRoot, outputDirectory: path.join(sourceRoot, "out"), version: "1.0.0" }), /outside the project tree/);
});
