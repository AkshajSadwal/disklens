import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFileWithAI } from "../server/src/services/aiService.mjs";

const providerKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT"];

test("AI file analysis remains usable offline with deterministic local rules", async () => {
  const saved = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
  for (const key of providerKeys) delete process.env[key];
  try {
    const result = await analyzeFileWithAI({
      name: "setup.exe",
      path: "/home/example/Downloads/setup.exe",
      extension: ".exe",
      size: 1024,
      digitalSignature: { status: "NotSigned", markOfWeb: false },
    });
    assert.equal(result.source, "local-rules");
    assert.equal(result.dangerLevel, "medium");
    assert.match(result.summary, /Local rule-based screening/);
    assert.match(result.deletionAdvice, /Do not delete/);
  } finally {
    for (const key of providerKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a configured but unavailable provider falls back to local rules", async () => {
  const saved = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of providerKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = "test-key-not-real";
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: "Invalid API key" } }),
  });
  try {
    const result = await analyzeFileWithAI({
      name: "unknown.exe", path: "/tmp/unknown.exe", extension: ".exe", size: 2048,
      digitalSignature: { status: "NotSigned", markOfWeb: true },
    });
    assert.equal(result.source, "local-rules");
    assert.ok(result.deletionAdvice.includes("Do not delete"));
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of providerKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("OpenAI is preferred when both hosted providers are configured", async () => {
  const saved = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of providerKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({ output_text: JSON.stringify({
        dangerLevel: "low", dangerScore: 15, confidence: 50,
        summary: "Mock provider response", indicators: [], reassuringSignals: [],
        recommendedAction: "review", deletionAdvice: "Verify before deleting.",
      }) }),
    };
  };
  try {
    const result = await analyzeFileWithAI({
      name: "notes.txt", path: "/tmp/notes.txt", extension: ".txt", size: 10,
    });
    assert.match(requestedUrl, /api\.openai\.com\/v1\/responses/);
    assert.equal(result.source, "openai");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of providerKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
