import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configDirectory = path.resolve(process.env.DISKLENS_CONFIG_DIR || defaultConfigDirectory());
const settingsPath = path.join(configDirectory, "ai-settings.json");
const encryptedKeyPath = path.join(configDirectory, "ai-key.dpapi");
const encryptedFallbackPath = path.join(configDirectory, "ai-key.local.enc");
const KEYCHAIN_SERVICE = "DiskLens AI Provider";
const fallbackUnlockDurationMs = 15 * 60 * 1000;
const DPAPI_SCRIPT = String.raw`$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class DiskLensDpapi {
  [StructLayout(LayoutKind.Sequential)] struct DATA_BLOB { public int cbData; public IntPtr pbData; }
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CryptProtectData(ref DATA_BLOB input, string description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DATA_BLOB output);
  [DllImport("crypt32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CryptUnprotectData(ref DATA_BLOB input, out IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out DATA_BLOB output);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static byte[] Transform(byte[] input, bool protect) {
    IntPtr inputPointer = IntPtr.Zero;
    DATA_BLOB output;
    IntPtr description = IntPtr.Zero;
    try {
      inputPointer = Marshal.AllocHGlobal(input.Length);
      Marshal.Copy(input, 0, inputPointer, input.Length);
      DATA_BLOB source = new DATA_BLOB { cbData = input.Length, pbData = inputPointer };
      bool ok = protect
        ? CryptProtectData(ref source, "DiskLens AI Provider", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output)
        : CryptUnprotectData(ref source, out description, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
      byte[] result = new byte[output.cbData];
      Marshal.Copy(output.pbData, result, 0, output.cbData);
      LocalFree(output.pbData);
      output.pbData = IntPtr.Zero;
      return result;
    } finally {
      Array.Clear(input, 0, input.Length);
      if (inputPointer != IntPtr.Zero) { for (int i = 0; i < input.Length; i++) Marshal.WriteByte(inputPointer, i, 0); Marshal.FreeHGlobal(inputPointer); }
      if (description != IntPtr.Zero) LocalFree(description);
    }
  }
  public static string Protect(string value) {
    byte[] input = Encoding.UTF8.GetBytes(value);
    byte[] output = Transform(input, true);
    try { return BitConverter.ToString(output).Replace("-", ""); }
    finally { Array.Clear(output, 0, output.Length); }
  }
  public static string Unprotect(string value) {
    if (String.IsNullOrEmpty(value) || value.Length % 2 != 0 || value.Length > 32768) throw new ArgumentException("Invalid DPAPI payload.");
    byte[] input = new byte[value.Length / 2];
    for (int i = 0; i < input.Length; i++) input[i] = Convert.ToByte(value.Substring(i * 2, 2), 16);
    byte[] output = Transform(input, false);
    try { return Encoding.UTF8.GetString(output); }
    finally { Array.Clear(output, 0, output.Length); }
  }
}
'@
Add-Type -TypeDefinition $source
$inputText = [Console]::In.ReadToEnd()
if ($env:DISKLENS_DPAPI_MODE -eq 'protect') { [DiskLensDpapi]::Protect($inputText) }
else { [DiskLensDpapi]::Unprotect($inputText) }`;
let metadataUpdateQueue = Promise.resolve();
let unlockedFallbackSecret = "";
let fallbackUnlockExpiresAt = 0;

export function macKeychainSaveRequest(secret) {
  // `security -i` reads commands from stdin. Use -X with hex data so the key
  // never appears in process arguments or needs command-line quoting.
  const encodedSecret = Buffer.from(secret, "utf8").toString("hex");
  const input = `add-generic-password -U -a DiskLens -s "${KEYCHAIN_SERVICE}" -X ${encodedSecret}\n`;
  if (Buffer.byteLength(input) >= 4096) throw new Error("The provider key is too long for secure macOS Keychain input.");
  return { args: ["-i"], input };
}

function defaultConfigDirectory() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "DiskLens");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "DiskLens");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "disklens");
}

function run(command, args, { input = "", env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else {
        const error = new Error(stderr.trim() || `${command} exited with status ${code}`);
        error.code = "CREDENTIAL_STORE_UNAVAILABLE";
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

async function ensureConfigDirectory() {
  await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(configDirectory, 0o700).catch(() => {});
}

async function readMetadata() {
  try {
    const data = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    if (!["local-rules", "openai", "anthropic", "azure-openai", "compatible"].includes(data.provider) || !["local-rules", "openai", "anthropic", "azure-openai", "compatible"].includes(data.defaultProvider || data.provider)) return null;
    return {
      provider: data.provider || "local-rules",
      model: data.model || "",
      endpoint: data.endpoint || "",
      defaultProvider: data.defaultProvider || data.provider || "local-rules",
      localFallback: data.localFallback !== false,
      maxResponseTokens: clamp(data.maxResponseTokens, 800, 64, 4096),
      requestBudget: clamp(data.requestBudget, 30, 1, 500),
      requestsToday: Number(data.requestsToday) || 0,
      requestDay: data.requestDay || "",
      lastProvider: data.lastProvider || "",
      keyConfigured: Boolean(data.keyConfigured),
      credentialStorage: ["os", "encrypted-local", "environment"].includes(data.credentialStorage) ? data.credentialStorage : (data.keyConfigured ? "os" : "none"),
      keyUnlocked: data.credentialStorage === "encrypted-local" ? isFallbackUnlocked() : Boolean(data.keyConfigured),
    };
  } catch {
    return null;
  }
}

function clamp(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function updateMetadata(mutator) {
  const result = metadataUpdateQueue.then(async () => {
    const data = await readMetadata();
    if (!data) return undefined;
    const next = await mutator(data);
    if (next) await writeMetadata(next);
    return next;
  });
  metadataUpdateQueue = result.catch(() => {});
  return result;
}

async function writeMetadata(data) {
  await ensureConfigDirectory();
  const temporaryPath = `${settingsPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(temporaryPath, 0o600).catch(() => {});
  try {
    await fs.rename(temporaryPath, settingsPath);
  } catch (error) {
    // Some Windows-protected user profile directories reject rename operations
    // even when both files are in the same directory. Keep a direct-write
    // fallback there; the temporary file stays private and is always removed.
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(error.code)) throw error;
    await fs.writeFile(settingsPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rm(temporaryPath, { force: true });
  }
}

function isFallbackUnlocked() {
  if (unlockedFallbackSecret && Date.now() >= fallbackUnlockExpiresAt) {
    unlockedFallbackSecret = "";
    fallbackUnlockExpiresAt = 0;
  }
  return Boolean(unlockedFallbackSecret);
}

function cacheUnlockedFallbackSecret(secret) {
  unlockedFallbackSecret = secret;
  fallbackUnlockExpiresAt = Date.now() + fallbackUnlockDurationMs;
}

function requireFallbackPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 1024 || /[\r\n]/.test(passphrase)) {
    const error = new Error("Use a local encryption passphrase with at least 12 characters.");
    error.code = "LOCAL_PASSPHRASE_INVALID";
    throw error;
  }
}

async function deriveFallbackKey(passphrase, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function writeEncryptedFallback(secret, passphrase) {
  requireFallbackPassphrase(passphrase);
  await ensureConfigDirectory();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveFallbackKey(passphrase, salt);
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("DiskLens local AI credential v1", "utf8"));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1, kdf: "scrypt-32768-8-1", salt: salt.toString("base64"),
      iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const temporaryPath = `${encryptedFallbackPath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, envelope, { mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(temporaryPath, 0o600).catch(() => {});
    try {
      await fs.rename(temporaryPath, encryptedFallbackPath);
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(error.code)) throw error;
      await fs.writeFile(encryptedFallbackPath, envelope, { mode: 0o600 });
      await fs.rm(temporaryPath, { force: true });
    }
    if (process.platform !== "win32") await fs.chmod(encryptedFallbackPath, 0o600).catch(() => {});
  } finally {
    key.fill(0);
  }
}

async function decryptEncryptedFallback(passphrase) {
  requireFallbackPassphrase(passphrase);
  const envelope = JSON.parse(await fs.readFile(encryptedFallbackPath, "utf8"));
  if (envelope.version !== 1 || envelope.kdf !== "scrypt-32768-8-1") throw new Error("Unsupported local credential format.");
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length > 8192) throw new Error("Invalid local credential format.");
  const key = await deriveFallbackKey(passphrase, salt);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from("DiskLens local AI credential v1", "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    const error = new Error("The local encryption passphrase is incorrect or the saved credential is damaged.");
    error.code = "LOCAL_SECRET_UNLOCK_FAILED";
    throw error;
  } finally {
    key.fill(0);
  }
}

async function saveOsSecret(secret) {
  if (!secret) return;
  await ensureConfigDirectory();
  if (process.platform === "win32") {
    const ciphertext = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], {
      input: secret, env: { ...process.env, DISKLENS_DPAPI_MODE: "protect" },
    });
    await fs.writeFile(encryptedKeyPath, ciphertext, { mode: 0o600 });
    return;
  }
  if (process.platform === "darwin") {
    // macOS Keychain is the only persistent credential store used here.
    const request = macKeychainSaveRequest(secret);
    await run("security", request.args, { input: request.input });
    const saved = await run("security", ["find-generic-password", "-a", "DiskLens", "-s", KEYCHAIN_SERVICE, "-w"]);
    if (saved !== secret) throw new Error("The macOS Keychain did not confirm the saved provider key.");
    return;
  }
  await run("secret-tool", ["store", "--label=DiskLens AI provider key", "application", "disklens", "name", "ai-provider-key"], { input: secret });
}

async function readOsSecret() {
  if (process.platform === "win32") {
    try {
      const ciphertext = await fs.readFile(encryptedKeyPath, "utf8");
      if (!ciphertext.trim()) return "";
      return await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], {
        input: ciphertext.trim(), env: { ...process.env, DISKLENS_DPAPI_MODE: "unprotect" },
      });
    } catch { return ""; }
  }
  try {
    if (process.platform === "darwin") return await run("security", ["find-generic-password", "-a", "DiskLens", "-s", KEYCHAIN_SERVICE, "-w"]);
    return await run("secret-tool", ["lookup", "application", "disklens", "name", "ai-provider-key"]);
  } catch { return ""; }
}

async function deleteOsSecret() {
  if (process.platform === "win32") {
    await fs.rm(encryptedKeyPath, { force: true });
  } else if (process.platform === "darwin") {
    await run("security", ["delete-generic-password", "-a", "DiskLens", "-s", KEYCHAIN_SERVICE]).catch(() => {});
  } else {
    await run("secret-tool", ["clear", "application", "disklens", "name", "ai-provider-key"]).catch(() => {});
  }
}

async function saveSecret(secret, localPassphrase = "") {
  if (!secret) return "none";
  if (localPassphrase) {
    await writeEncryptedFallback(secret, localPassphrase);
    await deleteOsSecret().catch(() => {});
    cacheUnlockedFallbackSecret(secret);
    return "encrypted-local";
  }
  try {
    await saveOsSecret(secret);
    await fs.rm(encryptedFallbackPath, { force: true });
    unlockedFallbackSecret = "";
    fallbackUnlockExpiresAt = 0;
    return "os";
  } catch (cause) {
    const error = new Error("The OS credential store is unavailable. Enter a local encryption passphrase and save again, or configure the key in server/.env.");
    error.code = "LOCAL_PASSPHRASE_REQUIRED";
    error.cause = cause;
    throw error;
  }
}

async function readSecret() {
  const metadata = await readMetadata();
  if (metadata?.credentialStorage === "encrypted-local") return isFallbackUnlocked() ? unlockedFallbackSecret : "";
  return readOsSecret();
}

async function deleteSecret() {
  await deleteOsSecret();
  await fs.rm(encryptedFallbackPath, { force: true });
  unlockedFallbackSecret = "";
  fallbackUnlockExpiresAt = 0;
}

export function validateProviderEndpoint(value, { allowLocalHttp = true } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid provider URL."); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase()) || url.hostname.toLowerCase().endsWith(".localhost");
  if (url.protocol !== "https:" && !(allowLocalHttp && url.protocol === "http:" && loopback)) {
    throw new Error("Provider URLs must use HTTPS. HTTP is allowed only for localhost endpoints.");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Provider URLs cannot contain credentials, a query, or a fragment.");
  return url.toString().replace(/\/$/, "");
}

export async function getAiSettings() {
  const data = await readMetadata();
  const openAiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
  const anthropicConfigured = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const legacyAzureConfigured = Boolean(process.env.AZURE_OPENAI_API_KEY?.trim() && process.env.AZURE_OPENAI_ENDPOINT?.trim());
  if (!data) {
    const envProvider = openAiConfigured ? "openai" : anthropicConfigured ? "anthropic" : legacyAzureConfigured ? "azure-openai" : "local-rules";
    return {
      provider: envProvider,
      defaultProvider: envProvider,
      model: envProvider === "openai" ? process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini" : envProvider === "anthropic" ? process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514" : process.env.AZURE_OPENAI_DEPLOYMENT?.trim() || "",
      endpoint: envProvider === "azure-openai" ? validateProviderEndpoint(process.env.AZURE_OPENAI_ENDPOINT) : "",
      keyConfigured: openAiConfigured || anthropicConfigured || legacyAzureConfigured,
      credentialStorage: openAiConfigured || anthropicConfigured || legacyAzureConfigured ? "environment" : "none",
      keyUnlocked: openAiConfigured || anthropicConfigured || legacyAzureConfigured,
      localFallback: true,
      maxResponseTokens: 800,
      requestBudget: 30,
      lastProvider: "",
    };
  }
  const envKey = data.provider === "openai" ? process.env.OPENAI_API_KEY : data.provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : data.provider === "azure-openai" ? process.env.AZURE_OPENAI_API_KEY : "";
  return { ...data, keyConfigured: data.keyConfigured || Boolean(envKey?.trim()) };
}

export async function saveAiSettings(input) {
  const provider = String(input.provider || "local-rules");
  if (!["local-rules", "openai", "anthropic", "azure-openai", "compatible"].includes(provider)) throw new Error("Choose a supported AI provider.");
  const model = String(input.model || "").trim().slice(0, 160);
  const endpoint = validateProviderEndpoint(input.endpoint);
  const key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (key.length > 8192 || /[\r\n]/.test(key)) throw new Error("The API key is invalid or too long.");
  if (String(input.endpoint || "").length > 2048) throw new Error("The provider URL is too long.");
  if (provider !== "local-rules" && !model) throw new Error("Enter a model name.");
  if (provider === "compatible" && !endpoint) throw new Error("Enter the compatible API base URL.");
  if (provider === "azure-openai" && !endpoint) throw new Error("Enter the Azure OpenAI resource endpoint.");

  const existing = await readMetadata();
  const localPassphrase = typeof input.localEncryptionPassphrase === "string" ? input.localEncryptionPassphrase : "";
  const envKey = provider === "openai" ? process.env.OPENAI_API_KEY : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : provider === "azure-openai" ? process.env.AZURE_OPENAI_API_KEY : "";
  const canReuseKey = existing?.provider === provider && existing?.keyConfigured;
  const keyConfigured = Boolean(key) || Boolean(envKey?.trim()) || Boolean(canReuseKey);
  if (provider !== "local-rules" && provider !== "compatible" && !keyConfigured) {
    throw new Error("Enter an API key before saving this provider.");
  }
  let credentialStorage = existing?.credentialStorage || "none";
  if (provider === "local-rules") { await deleteSecret(); credentialStorage = "none"; }
  else if (key) credentialStorage = await saveSecret(key, localPassphrase);
  else if (existing?.provider && existing.provider !== provider) { await deleteSecret(); credentialStorage = envKey?.trim() ? "environment" : "none"; }
  else if (envKey?.trim() && !existing?.keyConfigured) credentialStorage = "environment";
  const settings = {
    provider, model, endpoint,
    defaultProvider: provider,
    localFallback: input.localFallback !== false,
    maxResponseTokens: clamp(input.maxResponseTokens, 800, 64, 4096),
    requestBudget: clamp(input.requestBudget, 30, 1, 500),
    requestsToday: existing?.requestDay === new Date().toISOString().slice(0, 10) ? existing.requestsToday : 0,
    requestDay: new Date().toISOString().slice(0, 10),
    lastProvider: existing?.lastProvider || "",
    keyConfigured: provider === "local-rules" ? false : keyConfigured,
    credentialStorage: provider === "local-rules" ? "none" : credentialStorage,
  };
  await writeMetadata(settings);
  return {
    provider, defaultProvider: provider, model, endpoint,
    localFallback: settings.localFallback, maxResponseTokens: settings.maxResponseTokens,
    requestBudget: settings.requestBudget, keyConfigured: settings.keyConfigured,
    credentialStorage: settings.credentialStorage,
    keyUnlocked: settings.credentialStorage !== "encrypted-local" || isFallbackUnlocked(),
    lastProvider: settings.lastProvider,
  };
}

export async function unlockAiSettings(passphrase) {
  const settings = await readMetadata();
  if (settings?.credentialStorage !== "encrypted-local") {
    const error = new Error("No locally encrypted provider key needs unlocking.");
    error.code = "LOCAL_SECRET_NOT_CONFIGURED";
    throw error;
  }
  try {
    const secret = await decryptEncryptedFallback(passphrase);
    cacheUnlockedFallbackSecret(secret);
    return { ok: true, keyUnlocked: true };
  } catch (error) {
    if (error.code === "LOCAL_PASSPHRASE_INVALID") throw error;
    const failure = new Error("The local encryption passphrase is incorrect or the saved credential is damaged.");
    failure.code = "LOCAL_SECRET_UNLOCK_FAILED";
    throw failure;
  }
}

export async function removeAiSettings() {
  await deleteSecret();
  await fs.rm(settingsPath, { force: true });
  return getAiSettings();
}

export async function getRuntimeAiConfig() {
  const settings = await readMetadata();
  if (settings) {
    const provider = settings.defaultProvider || "local-rules";
    if (provider === "local-rules") return { provider, localFallback: settings.localFallback, maxResponseTokens: settings.maxResponseTokens };
    return {
      provider,
      key: await readSecret() || (provider === "openai" ? process.env.OPENAI_API_KEY?.trim() : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY?.trim() : provider === "azure-openai" ? process.env.AZURE_OPENAI_API_KEY?.trim() : ""),
      model: settings.model,
      endpoint: validateProviderEndpoint(settings.endpoint),
      localFallback: settings.localFallback,
      maxResponseTokens: settings.maxResponseTokens,
      requestBudget: settings.requestBudget,
      requestsToday: settings.requestDay === new Date().toISOString().slice(0, 10) ? settings.requestsToday : 0,
    };
  }
  if (process.env.OPENAI_API_KEY?.trim()) return { provider: "openai", key: process.env.OPENAI_API_KEY.trim(), model: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini", localFallback: true, maxResponseTokens: 800, requestBudget: 30 };
  if (process.env.ANTHROPIC_API_KEY?.trim()) return { provider: "anthropic", key: process.env.ANTHROPIC_API_KEY.trim(), model: process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514", localFallback: true, maxResponseTokens: 800, requestBudget: 30 };
  if (process.env.AZURE_OPENAI_API_KEY?.trim() && process.env.AZURE_OPENAI_ENDPOINT?.trim() && process.env.AZURE_OPENAI_DEPLOYMENT?.trim()) return { provider: "azure-openai", key: process.env.AZURE_OPENAI_API_KEY.trim(), model: process.env.AZURE_OPENAI_DEPLOYMENT.trim(), endpoint: validateProviderEndpoint(process.env.AZURE_OPENAI_ENDPOINT.trim()), localFallback: true, maxResponseTokens: 800, requestBudget: 30 };
  return { provider: "local-rules", localFallback: true, maxResponseTokens: 800 };
}

export async function recordAiProvider(provider) {
  await updateMetadata((data) => ({ ...data, lastProvider: provider }));
}

export async function consumeAiRequest() {
  await updateMetadata((data) => {
    if (data.defaultProvider === "local-rules") return null;
    const today = new Date().toISOString().slice(0, 10);
    if (data.requestDay !== today) { data.requestDay = today; data.requestsToday = 0; }
    if (data.requestsToday >= data.requestBudget) {
      const error = new Error("The configured daily AI request budget has been reached.");
      error.code = "AI_BUDGET_REACHED";
      throw error;
    }
    data.requestsToday += 1;
    return data;
  });
}

export async function testAiProvider(input) {
  const provider = String(input.provider || "");
  if (!["openai", "anthropic", "azure-openai", "compatible"].includes(provider)) throw new Error("Choose a hosted provider to test.");
  const endpoint = validateProviderEndpoint(input.endpoint);
  const inputKey = String(input.apiKey || "").trim();
  if (inputKey.length > 8192 || /[\r\n]/.test(inputKey)) throw new Error("The API key is invalid or too long.");
  if (String(input.endpoint || "").length > 2048) throw new Error("The provider URL is too long.");
  const activeSettings = await getAiSettings();
  const savedKey = activeSettings.provider === provider ? await readSecret() : "";
  const key = inputKey || savedKey ||
    (provider === "openai" ? process.env.OPENAI_API_KEY?.trim() : provider === "anthropic" ? process.env.ANTHROPIC_API_KEY?.trim() : provider === "azure-openai" ? process.env.AZURE_OPENAI_API_KEY?.trim() : "");
  if (!key && provider !== "compatible") throw new Error("Enter an API key to test this provider.");
  if (provider === "azure-openai" && !endpoint) throw new Error("Enter the Azure OpenAI resource endpoint.");
  const base = provider === "openai" ? endpoint || "https://api.openai.com/v1" : provider === "anthropic" ? "https://api.anthropic.com/v1" : provider === "azure-openai" ? `${endpoint.replace(/\/$/, "")}${endpoint.replace(/\/$/, "").endsWith("/openai/v1") ? "" : "/openai/v1"}` : endpoint;
  const url = provider === "anthropic" ? `${base}/models?limit=1` : `${base}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: provider === "anthropic"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : provider === "azure-openai" ? { "api-key": key } : key ? { authorization: `Bearer ${key}` } : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 || response.status === 403 ? "Authentication failed. Check the API key and provider access." : `Provider returned HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return { ok: true, provider, message: "Connection verified. No indexed storage data or generation request was sent." };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Connection test timed out after 10 seconds.");
    if (error.status) throw error;
    throw new Error("Could not reach the provider. Check the URL and network connection.");
  } finally {
    clearTimeout(timer);
  }
}
