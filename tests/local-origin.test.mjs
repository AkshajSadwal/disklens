import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { installDiskLensOriginPolicy, isAllowedDiskLensOrigin } from "../server/src/security/localOrigin.mjs";
import { buildFrontendDevArgs } from "../scripts/frontendCommand.mjs";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const Fastify = require("fastify");

test("DiskLens browser API access is limited to its configured UI origin", async (t) => {
  const uiOrigin = "http://127.0.0.1:4317";
  const app = Fastify();
  await installDiskLensOriginPolicy(app, uiOrigin);
  app.get("/read", async () => ({ ok: true }));
  app.post("/mutate", async () => ({ changed: true }));
  t.after(() => app.close());

  const trusted = await app.inject({ method: "GET", url: "/read", headers: { origin: uiOrigin } });
  assert.equal(trusted.statusCode, 200);
  assert.equal(trusted.headers["access-control-allow-origin"], uiOrigin);

  const otherLoopbackPort = await app.inject({
    method: "POST", url: "/mutate", headers: { origin: "http://127.0.0.1:4318" }, payload: { value: 1 },
  });
  assert.equal(otherLoopbackPort.statusCode, 403);
  assert.equal(otherLoopbackPort.json().code, "UNTRUSTED_ORIGIN");

  const remoteOrigin = await app.inject({ method: "GET", url: "/read", headers: { origin: "https://attacker.example" } });
  assert.equal(remoteOrigin.statusCode, 403);

  const localScript = await app.inject({ method: "POST", url: "/mutate", payload: { value: 1 } });
  assert.equal(localScript.statusCode, 200, "local scripts without a browser Origin remain supported");
});

test("origin comparison rejects malformed and non-origin URL values", () => {
  const expected = "http://127.0.0.1:3000";
  assert.equal(isAllowedDiskLensOrigin(undefined, expected), true);
  assert.equal(isAllowedDiskLensOrigin(expected, expected), true);
  assert.equal(isAllowedDiskLensOrigin("http://127.0.0.1:3001", expected), false);
  assert.equal(isAllowedDiskLensOrigin("http://127.0.0.1:3000.evil.example", expected), false);
  assert.equal(isAllowedDiskLensOrigin("http://user@127.0.0.1:3000", expected), false);
  assert.equal(isAllowedDiskLensOrigin("null", expected), false);
  assert.equal(isAllowedDiskLensOrigin("http://127.0.0.1:3000/path", expected), false);
  assert.equal(isAllowedDiskLensOrigin("https://attacker.example", "https://attacker.example"), false);
  assert.equal(isAllowedDiskLensOrigin("http://localhost:3000", "http://localhost:3000"), true);
});

test("launcher and direct frontend commands bind Next.js to loopback", async () => {
  assert.deepEqual(buildFrontendDevArgs("next", 4317), ["next", "dev", "-H", "127.0.0.1", "-p", "4317"]);
  const packageJson = JSON.parse(await readFile(new URL("../frontend/package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.dev, /(?:-H|--hostname)\s+127\.0\.0\.1/);
  assert.match(packageJson.scripts.start, /(?:-H|--hostname)\s+127\.0\.0\.1/);
});
