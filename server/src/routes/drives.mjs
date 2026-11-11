import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function upsertDrive(db, drive) {
  const totalBytes = Number(drive?.totalBytes);
  if (!drive?.root || !Number.isFinite(totalBytes) || totalBytes <= 0) return;

  db.prepare(`
    INSERT INTO drives (
      root,
      volume_name,
      file_system,
      total_bytes,
      free_bytes,
      used_bytes,
      drive_type,
      volume_serial_number,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET
      volume_name = excluded.volume_name,
      file_system = excluded.file_system,
      total_bytes = excluded.total_bytes,
      free_bytes = excluded.free_bytes,
      used_bytes = excluded.used_bytes,
      drive_type = excluded.drive_type,
      volume_serial_number = excluded.volume_serial_number,
      updated_at = excluded.updated_at
  `).run(
    String(drive.root),
    drive.volumeName || null,
    drive.fileSystem || null,
    totalBytes,
    Number(drive.freeBytes) || 0,
    Number(drive.usedBytes) || 0,
    Number.isFinite(Number(drive.driveType)) ? Number(drive.driveType) : null,
    drive.volumeSerialNumber || null,
    new Date().toISOString(),
  );
}

async function readLiveWindowsDrives() {
  const script = `
    Get-CimInstance Win32_LogicalDisk |
      Where-Object { $null -ne $_.Size -and $_.Size -gt 0 } |
      ForEach-Object {
        [PSCustomObject]@{
          root = $_.DeviceID
          volumeName = $_.VolumeName
          fileSystem = $_.FileSystem
          totalBytes = [int64]$_.Size
          freeBytes = [int64]$_.FreeSpace
          usedBytes = [int64]$_.Size - [int64]$_.FreeSpace
          driveType = [int]$_.DriveType
          volumeSerialNumber = $_.VolumeSerialNumber
        }
      } | ConvertTo-Json -Compress
  `;

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      // WMI/CIM can hang on slow or unhealthy Windows installations. The
      // dashboard must still be able to load using its stored drive metadata.
      timeout: 5000,
    },
  );

  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function readStoredDrives(db) {
  return db.prepare(`
    SELECT
      root,
      volume_name AS volumeName,
      file_system AS fileSystem,
      total_bytes AS totalBytes,
      free_bytes AS freeBytes,
      used_bytes AS usedBytes,
      drive_type AS driveType,
      volume_serial_number AS volumeSerialNumber,
      updated_at AS updatedAt
    FROM drives
    WHERE total_bytes > 0
    ORDER BY root
  `).all();
}

export function registerDriveRoutes(app, db) {
  app.get("/api/drives", async (request) => {
    try {
      const liveDrives = await readLiveWindowsDrives();
      for (const drive of liveDrives) upsertDrive(db, drive);
    } catch (error) {
      request.log.warn({ err: error }, "Could not read live Windows drive metadata; using stored values.");
    }

    return readStoredDrives(db);
  });

  app.post("/api/drives", async (request, reply) => {
    const drive = request.body ?? {};
    const totalBytes = Number(drive.totalBytes);

    if (
      typeof drive.root !== "string" ||
      !Number.isFinite(totalBytes) ||
      totalBytes <= 0
    ) {
      return reply.code(400).send({ error: "Invalid drive metadata" });
    }

    upsertDrive(db, drive);
    return { ok: true };
  });
}
