import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    const error = new Error(`${name} is not configured on the server.`);
    error.code = "AI_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function azureBaseUrl() {
  const raw = requiredEnv("AZURE_OPENAI_ENDPOINT").replace(/\/$/, "");
  return raw.endsWith("/openai/v1") ? `${raw}/` : `${raw}/openai/v1/`;
}

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

  throw new Error("Azure OpenAI returned invalid JSON.");
}

function providerConfig() {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return {
      provider: "openai",
      key: process.env.OPENAI_API_KEY.trim(),
      model: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
    };
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return {
      provider: "anthropic",
      key: process.env.ANTHROPIC_API_KEY.trim(),
      model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514",
    };
  }
  if (
    process.env.AZURE_OPENAI_API_KEY?.trim() &&
    process.env.AZURE_OPENAI_ENDPOINT?.trim() &&
    process.env.AZURE_OPENAI_DEPLOYMENT?.trim()
  ) {
    return { provider: "azure-openai", key: process.env.AZURE_OPENAI_API_KEY.trim() };
  }
  return null;
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

async function requestModel(input, schema, maxOutputTokens = 8000) {
  const config = providerConfig();
  if (!config) {
    const error = new Error("No hosted AI provider is configured.");
    error.code = "AI_NOT_CONFIGURED";
    throw error;
  }

  const { system, user } = messagesToPrompt(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    let response;
    if (config.provider === "openai") {
      const body = {
        model: config.model,
        input: [
          ...(system ? [{ role: "developer", content: system }] : []),
          { role: "user", content: user },
        ],
        max_output_tokens: maxOutputTokens,
      };
      if (schema) {
        body.text = {
          format: {
            type: "json_schema",
            name: schema.name,
            strict: true,
            schema: schema.schema,
          },
        };
      }
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } else if (config.provider === "anthropic") {
      const body = {
        model: config.model,
        max_tokens: maxOutputTokens,
        system: system || "You are a careful defensive storage analysis assistant.",
        messages: [{ role: "user", content: user }],
      };
      if (schema) {
        body.system += `\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema.schema)}`;
      }
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } else {
      const body = {
        model: process.env.AZURE_OPENAI_DEPLOYMENT.trim(),
        input,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: process.env.AZURE_OPENAI_REASONING_EFFORT?.trim() || "high" },
        text: { verbosity: "low" },
      };
      if (schema) {
        body.text.format = {
          type: "json_schema",
          name: schema.name,
          strict: true,
          schema: schema.schema,
        };
      }
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT.trim().replace(/\/$/, "");
      const base = endpoint.endsWith("/openai/v1") ? `${endpoint}/` : `${endpoint}/openai/v1/`;
      response = await fetch(`${base}responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "api-key": config.key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        payload?.error?.message || payload?.message || `${config.provider} returned HTTP ${response.status}`,
      );
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
    } else {
      outputText = extractOutputText(payload);
    }
    if (!outputText) throw new Error(`${config.provider} returned an empty response.`);
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

export async function analyzeFileWithAI(evidence) {
  return askJson([
    {
      role: "developer",
      content: `You are DiskLens AI, a defensive local-storage assistant. Analyze the supplied file evidence for security risk. Never claim certainty about malware from limited static evidence. Distinguish danger from ownership and deletion safety. A suspicious file should not be recommended for deletion merely because it is suspicious; recommend scanning/quarantine instead. Treat digital signatures as evidence, not proof of safety. Sensitive content may already be redacted. Return conservative, actionable results.\n\nFILE EVIDENCE:\n${JSON.stringify(evidence)}`,
    },
    {
      role: "user",
      content: "Assess the file's danger level and give deletion guidance.",
    },
  ], fileSchema, 5000, "file", evidence);
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

export async function analyzeStorageTopWithAI(snapshot) {
  return askJson([
    {
      role: "developer",
      content: `You are DiskLens AI, a defensive local-storage optimization assistant. The user asked you to review only the supplied TOP storage entities. You must not assume that a large item is useless. Identify things worth reviewing for storage optimization: old installers/downloads, caches, logs, temporary data, duplicate-looking archives, oversized forgotten files, or application data that is likely safe to regenerate. Prefer evidence from type, size, path, name, modification time, program install metadata, and size basis. Never invent paths or claims. Do not recommend deleting Windows/system files, dependencies, shared libraries, or personal data merely because they are large. Treat recommendations as review suggestions, not automatic deletion instructions. targetKeys must reference only the supplied entity keys. Estimated bytes are rough reviewable amounts, not guaranteed recoverable space. Return concise results.

TOP STORAGE EVIDENCE:\n${JSON.stringify(snapshot)}`,
    },
    {
      role: "user",
      content: "Suggest the most useful storage optimization opportunities in the supplied top items. Explain what should be reviewed and why.",
    },
  ], storageTopSchema, 6500, "storage-top", snapshot);
}

export async function analyzeStorageTargetWithAI(target) {
  return askJson([
    {
      role: "developer",
      content: `You are DiskLens AI, a defensive local-storage optimization assistant. Analyze ONLY the selected storage target. The target can be one program, one file, or one folder. Explain whether its storage footprint appears justified, what parts are worth reviewing, and what actions could reclaim space. Do not call anything useless with certainty. Never invent data or paths. Do not recommend deleting system files, dependencies, shared libraries, or personal data merely because they are large. For programs, distinguish installed size from indexed size basis. For folders, use fileCount/folderCount and indexed descendant size. For files, consider size, type, and age. Suggestions are advisory and require user review. Return concise results.

SELECTED TARGET:\n${JSON.stringify(target)}`,
    },
    {
      role: "user",
      content: "Give storage optimization advice specifically for this selected target.",
    },
  ], storageTargetSchema, 5000, "storage-target", target);
}

