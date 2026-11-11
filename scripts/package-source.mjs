import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([
  ".git", ".codex", ".next", ".turbo", ".cache", ".vercel", "node_modules",
  "dist", "coverage", "target", "build", "out", "artifacts",
  ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker",
]);
const skippedFiles = new Set([
  "ai-key.dpapi", "ai-key.local.enc", "ai-settings.json", "launcher.lock",
  ".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials.json",
  "token.json", "secrets.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);
const skippedExtensions = new Set([
  ".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".ppk", ".kdbx",
]);

export function shouldIncludePackageEntry(relativePath, isDirectory) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const baseName = lowerParts.at(-1) || "";
  if (lowerParts.some((part) => skippedDirectories.has(part))) return false;
  if (isDirectory) return true;
  if (baseName === ".env" || (baseName.startsWith(".env.") && baseName !== ".env.example")) return false;
  if (skippedFiles.has(baseName)) return false;
  if (skippedExtensions.has(path.extname(baseName))) return false;
  if (/(?:\.db|\.sqlite|\.sqlite3)-(?:wal|shm)$/.test(baseName)) return false;
  return true;
}

async function copySourceTree(sourceRoot, stageRoot) {
  const copied = [];
  async function visit(sourceDirectory, relativeDirectory = "") {
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(stageRoot, relativePath);
      if (entry.isSymbolicLink() || !shouldIncludePackageEntry(relativePath, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        await fs.mkdir(destinationPath, { recursive: true });
        await visit(sourcePath, relativePath);
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.copyFile(sourcePath, destinationPath);
        copied.push(relativePath);
      }
    }
  }
  await visit(sourceRoot);
  return copied;
}

export async function createSourcePackage({ sourceRoot = root, outputDirectory, version, tag = "" }) {
  if (!outputDirectory) throw new Error("Provide an output directory outside the project tree.");
  const normalizedVersion = String(version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion)) throw new Error("The project version must use stable X.Y.Z format.");
  const normalizedTag = String(tag || "").trim().replace(/^v/, "");
  if (normalizedTag && normalizedTag !== normalizedVersion) throw new Error(`Release tag ${tag} does not match package version ${normalizedVersion}.`);

  const temporaryParent = await fs.mkdtemp(path.join(os.tmpdir(), "disklens-source-package-"));
  const stageRoot = path.join(temporaryParent, `DiskLens-${normalizedVersion}`);
  const temporaryArchive = path.join(temporaryParent, `DiskLens-${normalizedVersion}-source.tar.gz`);
  const finalDirectory = path.resolve(outputDirectory);
  const relativeOutput = path.relative(path.resolve(sourceRoot), finalDirectory);
  if (relativeOutput === "" || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))) {
    throw new Error("The output directory must be outside the project tree.");
  }
  const finalArchive = path.join(finalDirectory, `DiskLens-${normalizedVersion}-source.tar.gz`);
  try {
    await fs.mkdir(stageRoot, { recursive: true });
    const copied = await copySourceTree(path.resolve(sourceRoot), stageRoot);
    if (!copied.some((entry) => entry === "README.md") || !copied.some((entry) => entry === path.join("server", "package.json"))) {
      throw new Error("The source tree is missing required README or server package metadata.");
    }
    if (copied.some((entry) => !shouldIncludePackageEntry(entry, false))) throw new Error("The source package contains a protected file.");
    await execFileAsync("tar", ["-czf", temporaryArchive, `DiskLens-${normalizedVersion}`], { cwd: temporaryParent, windowsHide: true });
    await fs.mkdir(finalDirectory, { recursive: true });
    await fs.copyFile(temporaryArchive, finalArchive);
    return { archive: finalArchive, fileCount: copied.length, version: normalizedVersion };
  } finally {
    await fs.rm(temporaryParent, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "server", "package.json"), "utf8"));
  const result = await createSourcePackage({
    sourceRoot: root,
    outputDirectory: value("--out"),
    version: packageJson.version,
    tag: value("--tag") || process.env.GITHUB_REF_NAME || "",
  });
  console.log(`Created ${result.archive} (${result.fileCount} files, version ${result.version}).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
