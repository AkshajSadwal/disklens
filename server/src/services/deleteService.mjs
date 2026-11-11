import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function ensureItem(itemPath, type) {
  const stat = await fs.lstat(itemPath);
  if (type === "file" && !stat.isFile()) {
    const error = new Error("Selected path is not a regular file.");
    error.code = "NOT_A_FILE";
    throw error;
  }
  if (type === "directory" && !stat.isDirectory()) {
    const error = new Error("Selected path is not a directory.");
    error.code = "NOT_A_DIRECTORY";
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const error = new Error("Symbolic links cannot be deleted through DiskLens.");
    error.code = "SYMLINK_PROTECTED";
    throw error;
  }
  return stat;
}

function isSameOrChild(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function ensureSafeDeletePath(targetPath) {
  const normalized = path.resolve(targetPath);
  const volumeRoot = path.parse(normalized).root;
  const protectedPaths = process.platform === "win32"
    ? [process.env.WINDIR || "C:\\Windows", process.env.ProgramFiles || "C:\\Program Files", process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", process.env.ProgramData || "C:\\ProgramData"]
    : process.platform === "darwin"
      ? ["/System", "/Library", "/bin", "/sbin", "/usr", "/etc", "/private"]
      : ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"];

  if (normalized === volumeRoot) {
    const error = new Error("Volume roots cannot be deleted.");
    error.code = "PROTECTED_PATH";
    throw error;
  }
  for (const protectedPath of protectedPaths) {
    const protectedResolved = path.resolve(protectedPath);
    const same = process.platform === "win32"
      ? normalized.toLowerCase() === protectedResolved.toLowerCase() || isSameOrChild(normalized.toLowerCase(), protectedResolved.toLowerCase())
      : isSameOrChild(normalized, protectedResolved);
    if (same) {
      const error = new Error("Protected operating-system or application directory cannot be deleted.");
      error.code = "PROTECTED_PATH";
      throw error;
    }
  }
}

async function moveToRecycleBin(itemPath, type) {
  await ensureItem(itemPath, type);
  ensureSafeDeletePath(itemPath);
  if (process.platform === "win32") {
    const script = `
      Add-Type -AssemblyName Microsoft.VisualBasic
      if ($env:DISKLENS_DELETE_TYPE -eq "directory") {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:DISKLENS_DELETE_PATH, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
      } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:DISKLENS_DELETE_PATH, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
      }
    `;
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...process.env, DISKLENS_DELETE_PATH: itemPath, DISKLENS_DELETE_TYPE: type },
    });
    return;
  }
  if (process.platform === "darwin") {
    const script = 'on run argv\nset targetItem to POSIX file (item 1 of argv)\ntell application "Finder" to delete targetItem\nend run';
    await execFileAsync("osascript", ["-e", script, itemPath], { timeout: 15000 });
    return;
  }
  try {
    await execFileAsync("gio", ["trash", itemPath], { timeout: 15000 });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await execFileAsync("trash-put", [itemPath], { timeout: 15000 });
    } catch (fallbackError) {
      if (fallbackError.code !== "ENOENT") throw fallbackError;
      const unavailable = new Error("A desktop trash utility (gio or trash-put) is not installed. Use permanent delete only after reviewing the warning.");
      unavailable.code = "TRASH_UNAVAILABLE";
      throw unavailable;
    }
  }
}

async function permanentlyDelete(itemPath, type) {
  await ensureItem(itemPath, type);
  ensureSafeDeletePath(itemPath);
  if (type === "directory") await fs.rm(itemPath, { recursive: true, force: false });
  else await fs.unlink(itemPath);
}

export async function deleteItem(itemPath, type, mode) {
  if (mode === "recycle") return moveToRecycleBin(itemPath, type);
  if (mode === "permanent") return permanentlyDelete(itemPath, type);
  const error = new Error("Invalid delete mode.");
  error.code = "INVALID_MODE";
  throw error;
}
