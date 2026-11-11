import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("AI settings persist metadata without returning secret fields", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-ai-settings-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = process.env.DISKLENS_CONFIG_DIR;
  process.env.DISKLENS_CONFIG_DIR = directory;
  const { getAiSettings, saveAiSettings } = await import(`../server/src/services/aiSettings.mjs?settings-test=${Date.now()}`);
  try {
    const saved = await saveAiSettings({ provider: "local-rules", localFallback: true, maxResponseTokens: 1200, requestBudget: 12 });
    assert.equal(saved.provider, "local-rules");
    assert.equal(saved.maxResponseTokens, 1200);
    const loaded = await getAiSettings();
    assert.equal(loaded.provider, "local-rules");
    assert.equal(loaded.keyConfigured, false);
    assert.equal(Object.hasOwn(loaded, "apiKey"), false);
    const raw = await fs.readFile(path.join(directory, "ai-settings.json"), "utf8");
    assert.equal(raw.toLowerCase().includes("apiKey".toLowerCase()), false);
  } finally {
    if (original === undefined) delete process.env.DISKLENS_CONFIG_DIR;
    else process.env.DISKLENS_CONFIG_DIR = original;
  }
});

test("provider endpoints require HTTPS except for loopback gateways", async () => {
  const { validateProviderEndpoint } = await import("../server/src/services/aiSettings.mjs");
  assert.equal(validateProviderEndpoint("https://ai.example/v1/"), "https://ai.example/v1");
  assert.equal(validateProviderEndpoint("http://localhost:11434/v1"), "http://localhost:11434/v1");
  assert.throws(() => validateProviderEndpoint("http://ai.example/v1"), /HTTPS/);
  assert.throws(() => validateProviderEndpoint("file:///etc/passwd"), /HTTPS/);
  assert.throws(() => validateProviderEndpoint("https://user:secret@ai.example/v1"), /cannot contain credentials/);
});

test("macOS Keychain save keeps provider keys out of process arguments", async () => {
  const { macKeychainSaveRequest } = await import("../server/src/services/aiSettings.mjs");
  const secret = "provider-key with spaces";
  const request = macKeychainSaveRequest(secret);
  assert.deepEqual(request.args, ["-i"]);
  assert.equal(request.input.includes(secret), false);
  assert.ok(request.input.includes(Buffer.from(secret, "utf8").toString("hex")));
  assert.match(request.input, /^add-generic-password -U -a DiskLens -s "DiskLens AI Provider" -X [0-9a-f]+\n$/);
  assert.throws(() => macKeychainSaveRequest("x".repeat(3000)), /too long/);
});

test("daily provider request budget is enforced before a hosted call", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-ai-budget-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const original = process.env.DISKLENS_CONFIG_DIR;
  process.env.DISKLENS_CONFIG_DIR = directory;
  const settings = await import(`../server/src/services/aiSettings.mjs?budget-test=${Date.now()}`);
  try {
    await settings.saveAiSettings({ provider: "compatible", model: "mock", endpoint: "http://localhost:11434/v1", requestBudget: 1 });
    await settings.consumeAiRequest();
    await assert.rejects(settings.consumeAiRequest(), { code: "AI_BUDGET_REACHED" });
  } finally {
    if (original === undefined) delete process.env.DISKLENS_CONFIG_DIR;
    else process.env.DISKLENS_CONFIG_DIR = original;
  }
});

test("local credential fallback encrypts keys and requires a fresh unlock after restart", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-ai-local-key-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envNames = ["DISKLENS_CONFIG_DIR", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.DISKLENS_CONFIG_DIR = directory;
  for (const name of envNames.slice(1)) delete process.env[name];
  const first = await import(`../server/src/services/aiSettings.mjs?local-key-save=${Date.now()}`);
  try {
    const saved = await first.saveAiSettings({
      provider: "openai", model: "gpt-4.1-mini", apiKey: "test-provider-secret",
      localEncryptionPassphrase: "a long local passphrase",
    });
    assert.equal(saved.credentialStorage, "encrypted-local");
    assert.equal(saved.keyUnlocked, true);
    assert.equal(Object.hasOwn(saved, "apiKey"), false);
    assert.equal((await first.getRuntimeAiConfig()).key, "test-provider-secret");
    const credentialPath = path.join(directory, "ai-key.local.enc");
    const encrypted = await fs.readFile(credentialPath, "utf8");
    assert.equal(encrypted.includes("test-provider-secret"), false);
    assert.equal(encrypted.includes("a long local passphrase"), false);
    if (process.platform !== "win32") assert.equal((await fs.stat(credentialPath)).mode & 0o777, 0o600);

    const restarted = await import(`../server/src/services/aiSettings.mjs?local-key-restart=${Date.now()}`);
    const locked = await restarted.getAiSettings();
    assert.equal(locked.credentialStorage, "encrypted-local");
    assert.equal(locked.keyUnlocked, false);
    assert.equal((await restarted.getRuntimeAiConfig()).key || "", "");
    await assert.rejects(restarted.unlockAiSettings("incorrect passphrase"), { code: "LOCAL_SECRET_UNLOCK_FAILED" });
    assert.deepEqual(await restarted.unlockAiSettings("a long local passphrase"), { ok: true, keyUnlocked: true });
    assert.equal((await restarted.getRuntimeAiConfig()).key, "test-provider-secret");
    await restarted.removeAiSettings();
    await assert.rejects(fs.access(credentialPath));
  } finally {
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test("Windows DPAPI credential storage round-trips without writing plaintext", { skip: process.platform !== "win32" }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-ai-dpapi-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envNames = ["DISKLENS_CONFIG_DIR", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.DISKLENS_CONFIG_DIR = directory;
  for (const name of envNames.slice(1)) delete process.env[name];
  const settings = await import(`../server/src/services/aiSettings.mjs?dpapi-test=${Date.now()}`);
  try {
    const saved = await settings.saveAiSettings({ provider: "openai", model: "gpt-4.1-mini", apiKey: "temporary-dpapi-test-key" }).catch((error) => {
      throw new Error(`DPAPI failed: ${error.cause?.message || error.message}`, { cause: error });
    });
    assert.equal(saved.credentialStorage, "os");
    assert.equal((await settings.getRuntimeAiConfig()).key, "temporary-dpapi-test-key");
    const dpapiPath = path.join(directory, "ai-key.dpapi");
    const ciphertext = await fs.readFile(dpapiPath, "utf8");
    assert.equal(ciphertext.includes("temporary-dpapi-test-key"), false);
    assert.ok(ciphertext.startsWith("01000000"), "DPAPI output retains the format used by the previous SecureString implementation");
    assert.equal((await settings.getRuntimeAiConfig()).key, "temporary-dpapi-test-key", "existing DPAPI blobs remain readable");
    await settings.removeAiSettings();
    await assert.rejects(fs.access(dpapiPath));
  } finally {
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  }
});

test("connection test uses a mocked model-list request, not generation", async () => {
  const { testAiProvider } = await import("../server/src/services/aiSettings.mjs");
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return { ok: true, status: 200 };
  };
  try {
    const result = await testAiProvider({ provider: "openai", apiKey: "mock-key" });
    assert.equal(result.ok, true);
    assert.equal(seen.url, "https://api.openai.com/v1/models");
    assert.equal(seen.options.method, undefined);
    assert.equal(seen.options.headers.authorization, "Bearer mock-key");
    assert.equal(seen.options.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Azure OpenAI v1 connection test lists models with api-key authentication", async () => {
  const { testAiProvider } = await import("../server/src/services/aiSettings.mjs");
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return { ok: true, status: 200 };
  };
  try {
    const result = await testAiProvider({
      provider: "azure-openai", endpoint: "https://example-resource.openai.azure.com",
      model: "disklens-deployment", apiKey: "mock-azure-key",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.url, "https://example-resource.openai.azure.com/openai/v1/models");
    assert.equal(seen.options.headers["api-key"], "mock-azure-key");
    assert.equal(seen.options.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
