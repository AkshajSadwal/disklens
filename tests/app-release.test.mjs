import test from "node:test";
import assert from "node:assert/strict";
import { isVersionNewer, registerAppRoutes } from "../server/src/routes/app.mjs";

function register({ fetchImpl, version = "1.4.2" }) {
  const handlers = new Map();
  registerAppRoutes({ get: (route, handler) => handlers.set(`GET ${route}`, handler), post: (route, handler) => handlers.set(`POST ${route}`, handler) }, { fetchImpl, version });
  return handlers;
}

async function invoke(handler) {
  const reply = { statusCode: 200, code(value) { this.statusCode = value; return this; }, send(value) { this.payload = value; return value; } };
  const result = await handler({}, reply);
  return { status: reply.statusCode, body: reply.payload || result };
}

test("release version comparison accepts only stable semantic versions", () => {
  assert.equal(isVersionNewer("v1.4.3", "1.4.2"), true);
  assert.equal(isVersionNewer("1.5.0", "1.4.9"), true);
  assert.equal(isVersionNewer("1.4.2", "1.4.2"), false);
  assert.equal(isVersionNewer("1.3.9", "1.4.0"), false);
  assert.equal(isVersionNewer("latest", "1.4.2"), null);
});

test("update check is explicit, returns a newer release, and exposes no release body", async () => {
  let calls = 0;
  let request;
  const handlers = register({
    version: "1.4.2",
    fetchImpl: async (url, options) => {
      calls += 1;
      request = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({
        tag_name: "v1.5.0", html_url: "https://github.com/AkshajSadwal/disklens/releases/tag/v1.5.0",
        body: "release notes are intentionally not returned",
      }) };
    },
  });
  assert.deepEqual((await invoke(handlers.get("GET /api/app/version"))).body, {
    version: "1.4.2", releasesUrl: "https://github.com/AkshajSadwal/disklens/releases",
  });
  assert.equal(calls, 0, "loading version information does not access GitHub");
  const checked = await invoke(handlers.get("POST /api/app/update-check"));
  assert.equal(calls, 1);
  assert.equal(request.url, "https://api.github.com/repos/AkshajSadwal/disklens/releases/latest");
  assert.equal(request.options.headers["x-github-api-version"], "2022-11-28");
  assert.deepEqual(checked.body, {
    currentVersion: "1.4.2", latestVersion: "v1.5.0", updateAvailable: true,
    releasesUrl: "https://github.com/AkshajSadwal/disklens/releases/tag/v1.5.0",
    message: "DiskLens v1.5.0 is available.",
  });
});

test("update check handles a repository without a published release", async () => {
  const handlers = register({ version: "1.0.0", fetchImpl: async () => ({ ok: false, status: 404 }) });
  const checked = await invoke(handlers.get("POST /api/app/update-check"));
  assert.equal(checked.status, 200);
  assert.equal(checked.body.latestVersion, null);
  assert.equal(checked.body.updateAvailable, false);
  assert.match(checked.body.message, /No public release/);
});
