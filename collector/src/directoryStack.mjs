import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * LIFO directory work queue with a fixed in-memory frontier. Very broad trees
 * spill older pending paths to a private temporary file instead of retaining
 * every subdirectory name in the collector heap.
 */
export class DirectoryStack {
  constructor({ maxInMemory = 1024, tempDirectory = os.tmpdir() } = {}) {
    if (!Number.isInteger(maxInMemory) || maxInMemory < 1) throw new RangeError("maxInMemory must be a positive integer.");
    this.maxInMemory = maxInMemory;
    this.tempDirectory = tempDirectory;
    this.memory = [];
    this.spoolDirectory = null;
    this.spool = null;
    this.spoolOffset = 0;
  }

  async push(value) {
    const entry = String(value);
    if (this.memory.length >= this.maxInMemory) {
      await this.#spillMemory();
    }
    this.memory.push(entry);
  }

  async pop() {
    if (this.memory.length) return this.memory.pop();
    if (!this.spoolOffset) return undefined;

    const trailer = Buffer.allocUnsafe(4);
    await readExactly(this.spool, trailer, this.spoolOffset - 4);
    const length = trailer.readUInt32BE(0);
    const recordStart = this.spoolOffset - length - 8;
    if (recordStart < 0) throw new Error("Directory work queue spool is corrupt.");
    const payload = Buffer.allocUnsafe(length);
    await readExactly(this.spool, payload, recordStart + 4);
    this.spoolOffset = recordStart;
    return payload.toString("utf8");
  }

  async close() {
    await this.spool?.close().catch(() => {});
    this.spool = null;
    if (this.spoolDirectory) await fs.rm(this.spoolDirectory, { recursive: true, force: true }).catch(() => {});
    this.spoolDirectory = null;
    this.spoolOffset = 0;
    this.memory.length = 0;
  }

  async #spillMemory() {
    if (!this.memory.length) return;
    if (!this.spool) {
      this.spoolDirectory = await fs.mkdtemp(path.join(this.tempDirectory, "disklens-queue-"));
      this.spool = await fs.open(path.join(this.spoolDirectory, "paths.bin"), "w+");
    }

    // Preserve stack order: the most recently discovered path must pop first.
    for (const value of this.memory) {
      const payload = Buffer.from(value, "utf8");
      if (payload.length > 0xffffffff) throw new RangeError("Directory path is too long to queue.");
      const length = Buffer.allocUnsafe(4);
      length.writeUInt32BE(payload.length, 0);
      this.spoolOffset = await writeExactly(this.spool, length, this.spoolOffset);
      this.spoolOffset = await writeExactly(this.spool, payload, this.spoolOffset);
      this.spoolOffset = await writeExactly(this.spool, length, this.spoolOffset);
    }
    this.memory.length = 0;
  }
}

async function writeExactly(handle, buffer, position) {
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!result.bytesWritten) throw new Error("Could not write directory work queue spool.");
    written += result.bytesWritten;
  }
  return position + written;
}

async function readExactly(handle, buffer, position) {
  let read = 0;
  while (read < buffer.length) {
    const result = await handle.read(buffer, read, buffer.length - read, position + read);
    if (!result.bytesRead) throw new Error("Could not read directory work queue spool.");
    read += result.bytesRead;
  }
}
