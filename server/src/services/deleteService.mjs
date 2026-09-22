import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function ensureFile(path) {
  const stat = await fs.lstat(path);

  if (!stat.isFile()) {
    const error = new Error("Selected path is not a regular file.");
    error.code = "NOT_A_FILE";
    throw error;
  }

  return stat;
}

export async function moveToRecycleBin(filePath) {
  await ensureFile(filePath);

  const script = `
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
      $env:DISKLENS_DELETE_PATH,
      [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
      [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
    )
  `;

  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        DISKLENS_DELETE_PATH: filePath,
      },
    },
  );
}

export async function permanentlyDelete(filePath) {
  await ensureFile(filePath);
  await fs.unlink(filePath);
}

export async function deleteFile(filePath, mode) {
  if (mode === "recycle") {
    await moveToRecycleBin(filePath);
    return;
  }

  if (mode === "permanent") {
    await permanentlyDelete(filePath);
    return;
  }

  const error = new Error("Invalid delete mode.");
  error.code = "INVALID_MODE";
  throw error;
}
