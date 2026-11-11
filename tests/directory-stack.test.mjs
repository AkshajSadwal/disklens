import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DirectoryStack } from "../collector/src/directoryStack.mjs";

test("directory work stack bounds memory, spills paths in stack order, and removes its spool", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-directory-stack-"));
  const stack = new DirectoryStack({ maxInMemory: 2, tempDirectory: parent });
  t.after(async () => {
    await stack.close();
    await fs.rm(parent, { recursive: true, force: true });
  });

  await stack.push("oldest");
  await stack.push("café\\folder\nwith newline");
  await stack.push("newest");
  assert.ok(stack.memory.length <= 2);
  assert.equal(await stack.pop(), "newest");
  await stack.push("newer after spill");
  assert.ok(stack.memory.length <= 2);
  assert.equal(await stack.pop(), "newer after spill");
  assert.equal(await stack.pop(), "café\\folder\nwith newline");
  assert.equal(await stack.pop(), "oldest");
  assert.equal(await stack.pop(), undefined);

  const spoolDirectory = stack.spoolDirectory;
  assert.ok(spoolDirectory);
  await stack.close();
  await assert.rejects(fs.stat(spoolDirectory), { code: "ENOENT" });
});
