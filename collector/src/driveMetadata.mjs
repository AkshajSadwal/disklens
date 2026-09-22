import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getDriveMetadata(root) {
  const drive = root.slice(0, 2);

  const script = `
    $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"

    if ($null -eq $d) {
      exit 1
    }

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
    {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );

  return JSON.parse(stdout);
}
