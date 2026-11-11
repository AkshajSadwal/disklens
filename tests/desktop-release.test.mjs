import test from "node:test";
import assert from "node:assert/strict";
import { buildFrontendStartArgs } from "../scripts/frontendCommand.mjs";
import { buildLocalApiTarget, isTrustedLocalProxyRequest } from "../frontend/lib/localApiProxy.mjs";

test("production frontend binds to loopback and uses the selected web port", () => {
  assert.deepEqual(buildFrontendStartArgs("next/bin/next", 3217), [
    "next/bin/next", "start", "-H", "127.0.0.1", "-p", "3217",
  ]);
});

test("local API proxy routes dynamic backend ports and preserves query strings", () => {
  const target = buildLocalApiTarget(
    "http://127.0.0.1:3217/api/explorer/search?q=r%C3%A9sum%C3%A9&page=2",
    ["explorer", "search"],
    "http://127.0.0.1:4217",
  );
  assert.equal(target, "http://127.0.0.1:4217/api/explorer/search?q=r%C3%A9sum%C3%A9&page=2");
});

test("local API proxy encodes path segments and rejects non-loopback upstreams", () => {
  assert.equal(
    buildLocalApiTarget("http://127.0.0.1:3000/api/folders", ["folder with spaces"]),
    "http://127.0.0.1:4000/api/folder%20with%20spaces",
  );
  assert.throws(() => buildLocalApiTarget("http://127.0.0.1:3000/api/items", ["items"], "https://example.com"), /loopback/);
});

test("local API proxy accepts only same-origin loopback browser requests for mutations", () => {
  assert.equal(isTrustedLocalProxyRequest(new Request("http://127.0.0.1:3000/api/items", {
    method: "POST", headers: { origin: "http://127.0.0.1:3000" },
  })), true);
  assert.equal(isTrustedLocalProxyRequest(new Request("http://127.0.0.1:3000/api/items", {
    method: "POST", headers: { origin: "http://attacker.example" },
  })), false);
  assert.equal(isTrustedLocalProxyRequest(new Request("http://127.0.0.1:3000/api/items", { method: "POST" })), false);
  assert.equal(isTrustedLocalProxyRequest(new Request("http://127.0.0.1:3000/api/items", { method: "GET" })), true);
  assert.equal(isTrustedLocalProxyRequest(new Request("http://192.168.1.12:3000/api/items", { method: "GET" })), false);
});
