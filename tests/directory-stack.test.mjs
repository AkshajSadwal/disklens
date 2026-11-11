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

test("directory work stack keeps a 5,000-entry frontier within its memory bound", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-directory-stack-wide-"));
  const stack = new DirectoryStack({ maxInMemory: 64, tempDirectory: parent });
  t.after(async () => {
    await stack.close();
    await fs.rm(parent, { recursive: true, force: true });
  });

  const count = 5000;
  for (let index = 0; index < count; index += 1) {
    await stack.push(`directory-${String(index).padStart(5, "0")}`);
    assert.ok(stack.memory.length <= 64, "the in-memory frontier must remain bounded");
  }
  assert.ok(stack.spoolDirectory, "a wide frontier should spill to a private temporary spool");

  for (let index = count - 1; index >= 0; index -= 1) {
    assert.equal(await stack.pop(), `directory-${String(index).padStart(5, "0")}`);
    assert.ok(stack.memory.length <= 64, "popping must not grow the in-memory frontier");
  }
  assert.equal(await stack.pop(), undefined);
});
