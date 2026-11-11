import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { consumeAiRequest, getRuntimeAiConfig, recordAiProvider, validateProviderEndpoint } from "./aiSettings.mjs";

const execFileAsync = promisify(execFile);

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];

  for (const item of payload?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
        continue;
      }

      if (typeof content?.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

function parseJson(text) {
  const cleaned = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  // Recover a JSON object embedded in a short natural-language wrapper.
  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");

  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(cleaned.slice(objectStart, objectEnd + 1));
    } catch {}
  }

  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
    } catch {}
  }

  throw new Error("The AI provider returned invalid structured data.");
}

function messagesToPrompt(input) {
  const system = input
    .filter((m) => m.role === "developer" || m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const user = input
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n");
  return { system, user };
}

export function buildProviderRequest(config, input, schema, maxOutputTokens) {
  const { system, user } = messagesToPrompt(input);
  if (config.provider === "openai") {
    const body = {
      model: config.model,
      input: [...(system ? [{ role: "developer", content: system }] : []), { role: "user", content: user }],
      max_output_tokens: maxOutputTokens,
    };
    if (schema) body.text = { format: { type: "json_schema", name: schema.name, strict: true, schema: schema.schema } };
    const base = config.endpoint ? `${config.endpoint.replace(/\/$/, "")}/` : "https://api.openai.com/v1/";
    return { url: `${base}responses`, headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` }, body };
  }
  if (config.provider === "anthropic") {
    const body = {
      model: config.model,
      max_tokens: maxOutputTokens,
      system: system || "You are a careful defensive storage analysis assistant.",
      messages: [{ role: "user", content: user }],
    };
    if (schema) body.system += `\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema.schema)}`;
    const base = config.endpoint || "https://api.anthropic.com/v1";
    return {
      url: `${base.replace(/\/$/, "")}/messages`,
      headers: { "content-type": "application/json", "x-api-key": config.key, "anthropic-version": "2023-06-01" },
      body,
    };
  }
  if (config.provider === "compatible") {
    const base = config.endpoint.replace(/\/$/, "");
    return {
      url: `${base}/chat/completions`,
      headers: { "content-type": "application/json", ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) },
      body: {
        model: config.model,
        messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
        max_tokens: maxOutputTokens,
        response_format: schema ? { type: "json_object" } : undefined,
      },
    };
  }
  if (config.provider === "azure-openai") {
    const body = {
      model: config.model || process.env.AZURE_OPENAI_DEPLOYMENT?.trim(),
      input,
      max_output_tokens: maxOutputTokens,
      reasoning: { effort: process.env.AZURE_OPENAI_REASONING_EFFORT?.trim() || "high" },
      text: { verbosity: "low" },
    };
    if (schema) body.text.format = { type: "json_schema", name: schema.name, strict: true, schema: schema.schema };
    const endpoint = validateProviderEndpoint(config.endpoint).replace(/\/$/, "");
    const base = endpoint.endsWith("/openai/v1") ? `${endpoint}/` : `${endpoint}/openai/v1/`;
    return { url: `${base}responses`, headers: { "content-type": "application/json", "api-key": config.key }, body };
  }
  return null;
}

function safeLocationCategory(value) {
  const normalized = String(value || "").toLowerCase().replaceAll("\\", "/");
  if (/(^|\/)downloads?(\/|$)/.test(normalized)) return "downloads";
  if (/(^|\/)(temp|tmp)(\/|$)/.test(normalized)) return "temporary";
  if (/(^|\/)cache(\/|$)/.test(normalized)) return "cache";
  if (/(^|\/)logs?(\/|$)/.test(normalized)) return "logs";
  if (/(^|\/)(appdata|application support|programdata)(\/|$)/.test(normalized)) return "application-data";
  return "other";
}

function minimalHostedFileEvidence(evidence) {
  return {
    type: "file", extension: String(evidence.extension || "").slice(0, 24),
    size: Math.max(0, Number(evidence.size) || 0), isExecutable: Boolean(evidence.isExecutable),
    locationCategory: safeLocationCategory(evidence.path),
    digitalSignature: { status: String(evidence.digitalSignature?.status || "Unknown").slice(0, 32), markOfWeb: Boolean(evidence.digitalSignature?.markOfWeb) },
  };
}

function minimalHostedStorageSnapshot(snapshot) {
  const entities = {};
  for (const [type, rows] of Object.entries(snapshot?.entities || {})) {
    entities[type] = (rows || []).slice(0, 20).map((row) => {
      if (type === "programs") return {
        key: row.key, type: "program", name: String(row.name || "").slice(0, 120),
        publisher: String(row.publisher || "").slice(0, 100), version: String(row.version || "").slice(0, 60),
        size: Math.max(0, Number(row.size) || 0), sizeBasis: row.sizeBasis,
      };
      if (type === "files") return {
        key: row.key, type: "file", extension: path.extname(String(row.name || "")).slice(0, 24),
        size: Math.max(0, Number(row.size) || 0), locationCategory: safeLocationCategory(row.path),
        modifiedAt: String(row.modifiedAt || "").slice(0, 24),
      };
      return {
        key: row.key, type: "folder", size: Math.max(0, Number(row.size) || 0),
        fileCount: Math.max(0, Number(row.fileCount) || 0), folderCount: Math.max(0, Number(row.folderCount) || 0),
        sizeBasis: row.sizeBasis, locationCategory: safeLocationCategory(row.path),
      };
    });
  }
  return { indexedFileCount: Math.max(0, Number(snapshot?.indexedFileCount) || 0), entities };
}

function minimalHostedTarget(target) {
  if (target.type === "program") return {
    type: "program", name: String(target.name || "").slice(0, 120), publisher: String(target.publisher || "").slice(0, 100),
    version: String(target.version || "").slice(0, 60), size: Math.max(0, Number(target.size) || 0), sizeBasis: target.sizeBasis,
    indexedFileCount: Math.max(0, Number(target.fileCount) || 0),
  };
  if (target.type === "file") return {
    type: "file", extension: path.extname(String(target.name || "")).slice(0, 24),
    size: Math.max(0, Number(target.size) || 0), modifiedAt: String(target.modifiedAt || "").slice(0, 24),
    locationCategory: safeLocationCategory(target.path),
  };
  return {
    type: "folder", size: Math.max(0, Number(target.size) || 0),
    fileCount: Math.max(0, Number(target.fileCount) || 0), folderCount: Math.max(0, Number(target.folderCount) || 0),
    sizeBasis: target.sizeBasis, locationCategory: safeLocationCategory(target.path),
  };
}

async function requestModel(input, schema, maxOutputTokens = 8000) {
  const config = await getRuntimeAiConfig();
  if (config.provider === "local-rules") {
    const error = new Error("No hosted AI provider is configured.");
    error.code = "AI_NOT_CONFIGURED";
    throw error;
  }
  if (!config.key && config.provider !== "compatible") {
    const error = new Error("The configured AI credential is unavailable from the operating system credential store.");
    error.code = "AI_NOT_CONFIGURED";
    throw error;
  }
  await consumeAiRequest();
  maxOutputTokens = Math.min(maxOutputTokens, config.maxResponseTokens || maxOutputTokens);

  const { system, user } = messagesToPrompt(input);
  if (Buffer.byteLength(system) + Buffer.byteLength(user) > 32 * 1024) {
    const error = new Error("This AI request exceeds the local input budget and was not sent.");
    error.code = "AI_INPUT_BUDGET_EXCEEDED";
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const providerRequest = buildProviderRequest(config, input, schema, maxOutputTokens);
    if (!providerRequest) throw new Error("The configured AI provider is not supported.");
    const response = await fetch(providerRequest.url, {
      method: "POST",
      headers: providerRequest.headers,
      body: JSON.stringify(providerRequest.body),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(`${config.provider} returned HTTP ${response.status}.`);
      error.status = response.status;
      error.provider = config.provider;
      throw error;
    }

    let outputText = "";
    if (config.provider === "anthropic") {
      outputText = (payload?.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n").trim();
    } else if (config.provider === "compatible") {
      outputText = payload?.choices?.[0]?.message?.content?.trim?.() || "";
    } else {
      outputText = extractOutputText(payload);
    }
    if (!outputText) throw new Error(`${config.provider} returned an empty response.`);
    await recordAiProvider(config.provider);
    return { text: outputText, provider: config.provider };
  } finally {
    clearTimeout(timeout);
  }
}

function localRuleAnalysis(kind, input) {
  const evidence = JSON.parse(JSON.stringify(input ?? {}));
  const bytes = (value) => Math.max(0, Number(value) || 0);
  const extension = String(evidence.extension || "").toLowerCase();
  const name = String(evidence.name || "").toLowerCase();
  const pathValue = String(evidence.path || "").toLowerCase();
  const indicators = [];
  const reassuringSignals = [];
  let score = 15;

  if (kind === "file") {
    if ([".exe", ".dll", ".sys", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".js"].includes(extension)) {
      score += 20;
      indicators.push("Executable or script file type can run code; this is a review signal, not proof of malware.");
    }
    if (evidence.digitalSignature?.status === "Valid") {
      score -= 25;
      reassuringSignals.push("A valid digital signature was reported by the local signature check.");
    } else if (evidence.digitalSignature?.status === "NotSigned") {
      score += 8;
      indicators.push("No digital signature was detected; many legitimate files are also unsigned.");
    }
    if (evidence.digitalSignature?.markOfWeb) {
      score += 12;
      indicators.push("Windows Mark-of-the-Web metadata suggests the file may have originated from the internet.");
    }
    if (/[\\/](temp|tmp|downloads?)[\\/]/i.test(pathValue)) {
      score += 5;
      indicators.push("The file is in a temporary or downloads location.");
    }
    if (bytes(evidence.size) > 500 * 1024 * 1024) {
      indicators.push("The file is unusually large; size alone does not indicate malicious behavior.");
    }
    if (evidence.hash?.sha256) reassuringSignals.push("A SHA-256 hash was collected for identification and comparison.");
    if (!indicators.length) reassuringSignals.push("No high-signal risk indicators were present in the collected metadata.");
    const dangerScore = Math.max(0, Math.min(100, score));
    return {
      dangerLevel: dangerScore >= 70 ? "high" : dangerScore >= 40 ? "medium" : "low",
      dangerScore,
      confidence: 35,
      summary: "Local rule-based screening only. This is not an antivirus verdict and does not establish whether the file is malicious.",
      indicators,
      reassuringSignals,
      recommendedAction: dangerScore >= 70 ? "scan" : dangerScore >= 40 ? "review" : "open",
      deletionAdvice: "Do not delete based on this score. Verify the file's origin and scan it with a trusted security product before taking action.",
      source: "local-rules",
    };
  }

  const entities = evidence.entities || {};
  const rows = kind === "storage-top"
    ? Object.values(entities).flat()
    : [evidence.target || evidence];
  const suggestions = [];
  for (const row of rows) {
    const rowName = String(row.name || "").toLowerCase();
    const rowPath = String(row.path || "").toLowerCase();
    const rowBytes = bytes(row.size ?? row.indexedBytes);
    if (!rowBytes) continue;
    const protectedPath = /[\\/](windows|system32|program files|programdata)[\\/]/i.test(rowPath);
    const likelyReview = /\.(iso|zip|7z|rar|msi|exe|dmp|log|tmp)$/i.test(rowName)
      || /[\\/](downloads|temp|cache|logs?)[\\/]/i.test(rowPath);
    if (protectedPath) continue;
    if (likelyReview || rowBytes >= 2 * 1024 ** 3) {
      suggestions.push({
        title: `Review ${row.name || row.path || "large item"}`,
        priority: rowBytes >= 10 * 1024 ** 3 ? "high" : "medium",
        confidence: 45,
        estimatedBytes: 0,
        targetKeys: row.key ? [row.key] : [],
        reason: "Its name, location, or size makes it a candidate for manual review. The local rules cannot determine whether its contents are still needed.",
        action: "Open the item, confirm ownership and backups, then decide whether it can be moved or removed.",
        caution: "Do not delete system files, application dependencies, backups, or personal data based only on this heuristic.",
      });
    }
  }
  if (kind === "storage-top") {
    return {
      summary: "Local rule-based storage review. No external AI provider was used.",
      suggestions: suggestions.slice(0, 10),
      source: "local-rules",
    };
  }
  const target = evidence.target || evidence;
  const targetSize = bytes(target.size ?? target.indexedBytes);
  return {
    summary: "Local rule-based assessment based on indexed metadata only.",
    storageAssessment: targetSize >= 10 * 1024 ** 3
      ? "This target has a substantial indexed storage footprint and may be worth reviewing."
      : "The available metadata does not show an unusually large storage footprint.",
    confidence: 40,
    opportunities: suggestions.slice(0, 8).map(({ targetKeys, ...item }) => item),
    keepReasons: ["The index does not reveal whether the data is personally important or required by an application."],
    finalAdvice: "Review the target manually and verify backups before deleting anything.",
    source: "local-rules",
  };
}

async function askJson(input, schema, maxOutputTokens = 8000, kind = "storage-target", fallbackData = {}) {
  try {
    const result = await requestModel(input, schema, maxOutputTokens);
    const parsed = parseJson(result.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.source = result.provider;
    }
    return parsed;
  } catch (error) {
    // A configured provider that is unavailable falls back to local heuristics.
    // No API key is required for the fallback path.
    const config = await getRuntimeAiConfig();
    if (!config.localFallback) throw error;
    await recordAiProvider("local-rules");
    return localRuleAnalysis(kind, fallbackData);
  }
}

const fileSchema = {
  name: "file_safety_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      dangerLevel: { type: "string", enum: ["unknown", "low", "medium", "high", "critical"] },
      dangerScore: { type: "integer", minimum: 0, maximum: 100 },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
      summary: { type: "string" },
      indicators: { type: "array", items: { type: "string" } },
      reassuringSignals: { type: "array", items: { type: "string" } },
      recommendedAction: { type: "string", enum: ["open", "review", "scan", "quarantine", "do_not_delete"] },
      deletionAdvice: { type: "string" },
    },
    required: ["dangerLevel", "dangerScore", "confidence", "summary", "indicators", "reassuringSignals", "recommendedAction", "deletionAdvice"],
  },
};

function isSensitiveKeyLike(line) {
  return /(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|connectionstring|private[_-]?key)/i.test(line);
}

function redactText(text) {
  return String(text ?? "")
    .replace(/([A-Za-z0-9_\-.]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|connectionstring|private[_-]?key)[A-Za-z0-9_\-.]*)\s*[:=]\s*[^\r\n]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[A-Za-z0-9._\-]+/g, "[REDACTED_JWT]");
}

async function readHead(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashSmallFile(filePath, size) {
  const maxHashBytes = 256 * 1024 * 1024;
  if (size > maxHashBytes) return { sha256: null, hashMode: "skipped-large-file" };

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), hashMode: "full" }));
  });
}

async function powershellSignature(filePath) {
  const script = String.raw`
$path = $env:DISKLENS_AI_PATH
$result = [ordered]@{
  status = "Unknown"
  signerSubject = ""
  signerIssuer = ""
  thumbprint = ""
  markOfWeb = $false
}
try {
  $sig = Get-AuthenticodeSignature -FilePath $path -ErrorAction Stop
  $result.status = [string]$sig.Status
  if ($sig.SignerCertificate) {
    $result.signerSubject = [string]$sig.SignerCertificate.Subject
    $result.signerIssuer = [string]$sig.SignerCertificate.Issuer
    $result.thumbprint = [string]$sig.SignerCertificate.Thumbprint
  }
} catch {}
try {
  $zone = Get-Item -LiteralPath $path -Stream Zone.Identifier -ErrorAction Stop
  $result.markOfWeb = $true
} catch {}
[PSCustomObject]$result | ConvertTo-Json -Compress
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, DISKLENS_AI_PATH: filePath },
      },
    );
    return JSON.parse(stdout || "{}");
  } catch {
    return {
      status: "Unavailable",
      signerSubject: "",
      signerIssuer: "",
      thumbprint: "",
      markOfWeb: false,
    };
  }
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".json", ".xml", ".ini", ".cfg", ".conf", ".yaml", ".yml",
  ".md", ".csv", ".js", ".jsx", ".ts", ".tsx", ".py", ".ps1", ".bat", ".cmd",
  ".vbs", ".wsf", ".sql", ".sh", ".html", ".css", ".java", ".c", ".cpp", ".h",
  ".hpp", ".rs", ".go", ".toml", ".properties", ".sln", ".cs", ".csproj", ".env",
]);

const EXECUTABLE_EXTENSIONS = new Set([".exe", ".dll", ".sys", ".msi", ".com", ".scr", ".cpl", ".ocx"]);

function extractStrings(buffer) {
  const latin = buffer.toString("latin1");
  const matches = latin.match(/[ -~]{6,}/g) || [];
  return [...new Set(matches.filter((value) => value.length <= 180))].slice(0, 120);
}

export async function collectFileEvidence(item) {
  const stat = await fs.lstat(item.path);
  if (!stat.isFile()) {
    const error = new Error("Selected item is no longer a regular file.");
    error.code = "NOT_A_FILE";
    throw error;
  }

  const extension = path.extname(item.name).toLowerCase();
  const signature = await powershellSignature(item.path);
  const hash = await hashSmallFile(item.path, stat.size);
  const evidence = {
    path: item.path,
    name: item.name,
    extension,
    size: stat.size,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    isExecutable: EXECUTABLE_EXTENSIONS.has(extension),
    digitalSignature: signature,
    hash,
  };

  if (TEXT_EXTENSIONS.has(extension)) {
    const buffer = await readHead(item.path, 64 * 1024);
    evidence.contentSample = redactText(buffer.toString("utf8"));
    evidence.contentSampleBytes = buffer.length;
  } else if (EXECUTABLE_EXTENSIONS.has(extension)) {
    const buffer = await readHead(item.path, 1024 * 1024);
    evidence.embeddedStringsSample = redactText(extractStrings(buffer).join("\n"));
    evidence.embeddedStringsBytes = buffer.length;
  }

  return evidence;
}

export function buildFileInput(evidence) {
  const hostedEvidence = minimalHostedFileEvidence(evidence);
  const messages = [
    {
      role: "developer",
      content: `You are DiskLens AI, a defensive local-storage assistant. Analyze the supplied metadata for security risk. Never claim certainty about malware from limited static evidence. Distinguish danger from ownership and deletion safety. A suspicious file should not be recommended for deletion merely because it is suspicious; recommend scanning/quarantine instead. Treat digital signatures as evidence, not proof of safety. The evidence is metadata only; no path, filename, file contents, or file hash is supplied. Return conservative, actionable results.\n\nFILE METADATA:\n${JSON.stringify(hostedEvidence)}`,
    },
    {
      role: "user",
      content: "Assess the file's danger level and give deletion guidance.",
    },
  ];
  const responseSchema = fileSchema;
  const serialized = JSON.stringify({ messages, responseSchema });
  return { messages, responseSchema, inputBytes: Buffer.byteLength(serialized), estimatedInputTokens: Math.ceil(Buffer.byteLength(serialized) / 4) };
}

export async function analyzeFileWithAI(evidence) {
  return askJson(buildFileInput(evidence).messages, fileSchema, 5000, "file", evidence);
}

const storageTopSchema = {
  name: "storage_top_optimization",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      suggestions: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            priority: { type: "string", enum: ["high", "medium", "low"] },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            estimatedBytes: { type: "integer", minimum: 0 },
            targetKeys: { type: "array", maxItems: 12, items: { type: "string" } },
            reason: { type: "string" },
            action: { type: "string" },
            caution: { type: "string" },
          },
          required: ["title", "priority", "confidence", "estimatedBytes", "targetKeys", "reason", "action", "caution"],
        },
      },
    },
    required: ["summary", "suggestions"],
  },
};

const storageTargetSchema = {
  name: "storage_target_optimization",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      storageAssessment: { type: "string" },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
      opportunities: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            priority: { type: "string", enum: ["high", "medium", "low"] },
            confidence: { type: "integer", minimum: 0, maximum: 100 },
            estimatedBytes: { type: "integer", minimum: 0 },
            reason: { type: "string" },
            action: { type: "string" },
            caution: { type: "string" },
          },
          required: ["title", "priority", "confidence", "estimatedBytes", "reason", "action", "caution"],
        },
      },
      keepReasons: { type: "array", maxItems: 8, items: { type: "string" } },
      finalAdvice: { type: "string" },
    },
    required: ["summary", "storageAssessment", "confidence", "opportunities", "keepReasons", "finalAdvice"],
  },
};

export function buildStorageTopInput(snapshot) {
  const messages = [
    {
      role: "developer",
      content: `You are DiskLens AI, a defensive local-storage optimization assistant. Review only the supplied top storage summaries. Do not assume large items are useless. Use only supplied type, extension, size, coarse location category, age, and program size metadata. Never infer or invent filenames, paths, or personal data. Do not recommend deleting system files, dependencies, shared libraries, or personal data merely because they are large. Suggestions are review-only and never execute actions. targetKeys must reference supplied entity keys. Estimated bytes are rough review amounts, not guaranteed recoverable space. Return concise results.

TOP STORAGE SUMMARIES:\n${JSON.stringify(minimalHostedStorageSnapshot(snapshot))}`,
    },
    {
      role: "user",
      content: "Suggest the most useful storage optimization opportunities in the supplied top items. Explain what should be reviewed and why.",
    },
  ];
  const responseSchema = storageTopSchema;
  const serialized = JSON.stringify({ messages, responseSchema });
  return { messages, responseSchema, inputBytes: Buffer.byteLength(serialized), estimatedInputTokens: Math.ceil(Buffer.byteLength(serialized) / 4) };
}

export async function analyzeStorageTopWithAI(snapshot) {
  return askJson(buildStorageTopInput(snapshot).messages, storageTopSchema, 6500, "storage-top", snapshot);
}

export function buildStorageTargetInput(target) {
  const messages = [
    {
      role: "developer",
      content: `You are DiskLens AI, a defensive local-storage optimization assistant. Analyze only the selected target summary. Explain the supplied footprint, what may be worth reviewing, and possible actions. Do not call anything useless with certainty or invent paths, filenames, or contents. For programs distinguish installed estimates from indexed size. For folders use supplied descendant counts and size. Suggestions are advisory and require user review. Return concise results.

SELECTED SUMMARY:\n${JSON.stringify(minimalHostedTarget(target))}`,
    },
    {
      role: "user",
      content: "Give storage optimization advice specifically for this selected target.",
    },
  ];
  const responseSchema = storageTargetSchema;
  const serialized = JSON.stringify({ messages, responseSchema });
  return { messages, responseSchema, inputBytes: Buffer.byteLength(serialized), estimatedInputTokens: Math.ceil(Buffer.byteLength(serialized) / 4) };
}

export async function analyzeStorageTargetWithAI(target) {
  return askJson(buildStorageTargetInput(target).messages, storageTargetSchema, 5000, "storage-target", target);
}

