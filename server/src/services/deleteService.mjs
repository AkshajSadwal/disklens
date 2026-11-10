import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function ensureItem(path, type) {
  const stat = await fs.lstat(path);

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

  return stat;
}

function ensureSafeDeletePath(targetPath) {
  const normalized = targetPath.replace(/[\\/]+$/, "").toUpperCase();
  const protectedPaths = [
    "C:\\WINDOWS",
    "C:\\PROGRAM FILES",
    "C:\\PROGRAM FILES (X86)",
    "C:\\PROGRAMDATA",
  ];

  if (/^[A-Z]:$/.test(normalized)) {
    const error = new Error("Drive roots cannot be deleted.");
    error.code = "PROTECTED_PATH";
    throw error;
  }

  for (const protectedPath of protectedPaths) {
    if (normalized === protectedPath || normalized.startsWith(`${protectedPath}\\`)) {
      const error = new Error("Protected Windows or application directory cannot be deleted.");
      error.code = "PROTECTED_PATH";
      throw error;
    }
  }
}

export async function moveToRecycleBin(itemPath, type) {
  await ensureItem(itemPath, type);
  ensureSafeDeletePath(itemPath);

  const script = `
    Add-Type -AssemblyName Microsoft.VisualBasic
    if ($env:DISKLENS_DELETE_TYPE -eq "directory") {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
        $env:DISKLENS_DELETE_PATH,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
      )
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $env:DISKLENS_DELETE_PATH,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
      )
    }
  `;

  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        DISKLENS_DELETE_PATH: itemPath,
        DISKLENS_DELETE_TYPE: type,
      },
    },
  );
}

export async function permanentlyDelete(itemPath, type) {
  await ensureItem(itemPath, type);
  ensureSafeDeletePath(itemPath);

  if (type === "directory") {
    await fs.rm(itemPath, { recursive: true, force: false });
  } else {
    await fs.unlink(itemPath);
  }
}

export async function deleteItem(itemPath, type, mode) {
  if (mode === "recycle") {
    await moveToRecycleBin(itemPath, type);
    return;
  }

  if (mode === "permanent") {
    await permanentlyDelete(itemPath, type);
    return;
  }

  const error = new Error("Invalid delete mode.");
  error.code = "INVALID_MODE";
  throw error;
}
