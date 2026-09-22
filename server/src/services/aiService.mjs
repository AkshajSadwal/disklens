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

async function requestAzure(input, schema, maxOutputTokens = 8000) {
  const body = {
    model: requiredEnv("AZURE_OPENAI_DEPLOYMENT"),
    input,
    max_output_tokens: maxOutputTokens,
    reasoning: {
      effort: process.env.AZURE_OPENAI_REASONING_EFFORT?.trim() || "high",
    },
    text: {
      verbosity: "low",
    },
  };

  if (schema) {
    body.text.format = {
      type: "json_schema",
      name: schema.name,
      strict: true,
      schema: schema.schema,
    };
  }

  const response = await fetch(`${azureBaseUrl()}responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": requiredEnv("AZURE_OPENAI_API_KEY"),
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || `Azure OpenAI returned HTTP ${response.status}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const outputText = extractOutputText(payload);

  if (!outputText) {
    const error = new Error(
      payload?.incomplete_details?.reason
        ? `Azure OpenAI response was incomplete: ${payload.incomplete_details.reason}`
        : `Azure OpenAI returned no text output (status: ${payload?.status || "unknown"}).`,
    );
    error.status = 502;
    error.payload = payload;
    error.code = "AI_EMPTY_OUTPUT";
    throw error;
  }

  if (payload?.status === "incomplete") {
    const error = new Error(
      `Azure OpenAI response was incomplete: ${payload?.incomplete_details?.reason || "unknown reason"}`,
    );
    error.status = 502;
    error.payload = payload;
    error.code = "AI_INCOMPLETE";
    throw error;
  }

  return outputText;
}

async function askJson(input, schema, maxOutputTokens = 8000) {
  try {
    const text = await requestAzure(input, schema, maxOutputTokens);
    return parseJson(text);
  } catch (error) {
    // Some Azure deployments may reject JSON Schema. Retry once as plain text.
    if (schema && error.status === 400) {
      const fallbackInput = [
        ...input,
        {
          role: "developer",
          content:
            "Return ONLY one valid JSON object matching the requested structure. Do not use markdown, code fences, commentary, or explanations.",
        },
      ];

      const text = await requestAzure(fallbackInput, null, maxOutputTokens);
      return parseJson(text);
    }

    throw error;
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
  ], fileSchema, 5000);
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
  ], storageTopSchema, 6500);
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
  ], storageTargetSchema, 5000);
}

