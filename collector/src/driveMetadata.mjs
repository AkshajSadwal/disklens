import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function windowsDriveMetadata(root) {
  const match = String(root).match(/^([A-Za-z]:)(?:\\|\/)?$/);
  if (!match) throw new Error("Windows drive metadata requires a drive root such as C:\\");
  const drive = match[1].toUpperCase();
  const script = `
    $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"
    if ($null -eq $d) { exit 1 }
    [PSCustomObject]@{
      root = $d.DeviceID
      volumeName = $d.VolumeName
      fileSystem = $d.FileSystem
      totalBytes = [int64]$d.Size
      freeBytes = [int64]$d.FreeSpace
      usedBytes = [int64]$d.Size - [int64]$d.FreeSpace
      driveType = [int]$d.DriveType
      volumeSerialNumber = $d.VolumeSerialNumber
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15000 },
  );
  return JSON.parse(stdout);
}

export async function getDriveMetadata(root) {
  const resolved = path.resolve(root);
  const stat = await fs.statfs(resolved);
  const blockSize = Number(stat.bsize || stat.frsize || 1);
  const totalBytes = Number(stat.blocks) * blockSize;
  const freeBytes = Number(stat.bavail ?? stat.bfree) * blockSize;

  let volumeName = path.parse(resolved).root || resolved;
  let fileSystem = os.platform();
  let driveType = null;
  let volumeSerialNumber = null;

  if (process.platform === "win32") {
    return windowsDriveMetadata(resolved);
  }

  if (process.platform === "darwin") {
    fileSystem = "macOS filesystem";
  } else if (process.platform === "linux") {
    fileSystem = "Linux filesystem";
  }

  return {
    root: resolved,
    volumeName,
    fileSystem,
    totalBytes,
    freeBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes),
    driveType,
    volumeSerialNumber,
  };
}
