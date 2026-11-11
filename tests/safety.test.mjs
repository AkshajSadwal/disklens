import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ensureSafeDeletePath } from "../server/src/services/deleteService.mjs";
import { buildProgramCandidates } from "../server/src/services/programAnalysis.mjs";

test("delete guard rejects filesystem roots and operating-system locations", () => {
  assert.throws(() => ensureSafeDeletePath(path.parse(process.cwd()).root), { code: "PROTECTED_PATH" });
  if (process.platform !== "win32") {
    assert.throws(() => ensureSafeDeletePath("/etc/passwd"), { code: "PROTECTED_PATH" });
    assert.doesNotThrow(() => ensureSafeDeletePath(path.join(process.env.HOME || "/tmp", "Downloads", "sample.zip")));
  }
});

test("program cleanup identifies indexed files under POSIX app bundle paths", () => {
  const result = buildProgramCandidates([
    { id: 1, path: "/Applications/Example.app/Contents/MacOS/Example", name: "Example", type: "file", size: 123 },
  ], { name: "Example", installLocation: "/Applications/Example.app" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].category, "verified");
});
