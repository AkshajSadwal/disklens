import test from "node:test";
import assert from "node:assert/strict";
import { requireSupportedNodeRuntime, supportsDiskLensNode } from "../shared/nodeRuntime.mjs";

test("runtime policy rejects end-of-life Node 20 and accepts supported major lines", () => {
  assert.equal(supportsDiskLensNode("20.20.0"), false);
  assert.equal(supportsDiskLensNode("v22.0.0"), true);
  assert.equal(supportsDiskLensNode("24.18.0"), true);
  assert.equal(supportsDiskLensNode("v26.0.0"), true);
  assert.equal(supportsDiskLensNode("not-a-version"), false);
  assert.throws(() => requireSupportedNodeRuntime("DiskLens", "20.20.0"), { code: "UNSUPPORTED_NODE_VERSION" });
});
