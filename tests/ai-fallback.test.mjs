import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFileWithAI, analyzeStorageTopWithAI, buildProviderRequest, buildStorageTargetInput, buildStorageTopInput } from "../server/src/services/aiService.mjs";

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
  let requestBody = "";
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestBody = options.body;
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
      name: "notes.txt", path: "/home/alex/private/notes.txt", extension: ".txt", size: 10,
      contentSample: "never send this document text", hash: { sha256: "private-hash" },
    });
    assert.match(requestedUrl, /api\.openai\.com\/v1\/responses/);
    assert.equal(result.source, "openai");
    assert.equal(requestBody.includes("/home/alex/private/notes.txt"), false);
    assert.equal(requestBody.includes("never send this document text"), false);
    assert.equal(requestBody.includes("private-hash"), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of providerKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("hosted storage summaries omit full paths and file names", async () => {
  const saved = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of providerKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = "test-openai-key";
  let requestBody = "";
  globalThis.fetch = async (_url, options) => {
    requestBody = options.body;
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ summary: "Mock", suggestions: [] }) }) };
  };
  try {
    const result = await analyzeStorageTopWithAI({
      indexedFileCount: 900,
      entities: {
        programs: [{ key: "program:tool", name: "Example Tool", publisher: "Example Co", size: 100, sizeBasis: "estimated" }],
        files: [{ key: "file:1", id: 1, name: "unique-secret-filename.xlsx", path: "C:\\Users\\alice\\Documents\\unique-secret-filename.xlsx", size: 200, modifiedAt: "2026-01-01" }],
        folders: [{ key: "folder:2", id: 2, name: "Private Folder", path: "C:\\Users\\alice\\Private Folder", size: 500, fileCount: 4, folderCount: 1 }],
      },
    });
    assert.equal(result.source, "openai");
    assert.equal(requestBody.includes("C:\\\\Users"), false);
    assert.equal(requestBody.includes("unique-secret-filename"), false);
    assert.equal(requestBody.includes("Private Folder"), false);
    assert.equal(requestBody.includes("Example Tool"), true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of providerKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("AI previews contain the exact bounded, minimized advisor messages", () => {
  const top = buildStorageTopInput({
    indexedFileCount: 8,
    entities: {
      programs: [{ key: "program:app", name: "Example App", publisher: "Example", size: 4096 }],
      files: [{ key: "file:1", name: "private-plan.docx", path: "/home/alex/private/private-plan.docx", size: 1234 }],
      folders: [{ key: "folder:1", name: "Secret Folder", path: "/home/alex/Secret Folder", size: 2000 }],
    },
  });
  const topText = JSON.stringify(top.messages);
  assert.equal(topText.includes("private-plan.docx"), false);
  assert.equal(topText.includes("Secret Folder"), false);
  assert.equal(topText.includes("/home/alex"), false);
  assert.equal(topText.includes("Example App"), true);
  assert.equal(top.inputBytes, Buffer.byteLength(JSON.stringify({ messages: top.messages, responseSchema: top.responseSchema })));
  assert.equal(top.estimatedInputTokens, Math.ceil(top.inputBytes / 4));

  const target = buildStorageTargetInput({
    type: "file", name: "private-plan.docx", path: "/home/alex/private/private-plan.docx",
    size: 1234, modifiedAt: "2026-01-01T00:00:00.000Z", extension: ".docx",
  });
  const targetText = JSON.stringify(target.messages);
  assert.equal(targetText.includes("private-plan.docx"), false);
  assert.equal(targetText.includes("/home/alex"), false);
  assert.equal(targetText.includes("docx"), true);
  assert.ok(target.inputBytes <= 32 * 1024);
});

test("Azure OpenAI request body uses v1 endpoint and deployment as model", () => {
  const request = buildProviderRequest({
    provider: "azure-openai", endpoint: "https://resource.openai.azure.com", model: "deployment-name", key: "secret",
  }, [{ role: "user", content: "storage summary" }], null, 600);
  assert.equal(request.url, "https://resource.openai.azure.com/openai/v1/responses");
  assert.equal(request.body.model, "deployment-name");
  assert.equal(request.headers["api-key"], "secret");
  assert.equal(request.body.max_output_tokens, 600);
});
