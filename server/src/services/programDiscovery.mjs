import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function cleanIcon(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  const withoutQuotes = raw.replace(/^"|"$/g, "");
  const comma = withoutQuotes.lastIndexOf(",");
  if (comma > 0 && /^-?\d+$/.test(withoutQuotes.slice(comma + 1).trim())) {
    return withoutQuotes.slice(0, comma).trim().replace(/^"|"$/g, "");
  }
  return withoutQuotes;
}

async function discoverWindowsPrograms() {
  const script = String.raw`
$roots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$skipReleaseTypes = @('Security Update', 'Update', 'Hotfix', 'Service Pack', 'Feature Pack')
$result = foreach ($root in $roots) {
  Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 -and $_.ReleaseType -notin $skipReleaseTypes -and $_.ParentKeyName -eq $null } |
    ForEach-Object {
      [PSCustomObject]@{
        name = [string]$_.DisplayName; version = [string]$_.DisplayVersion
        publisher = [string]$_.Publisher; installLocation = [string]$_.InstallLocation
        displayIcon = [string]$_.DisplayIcon
        estimatedSizeKB = if ($null -ne $_.EstimatedSize) { [int64]$_.EstimatedSize } else { 0 }
        installDate = [string]$_.InstallDate; uninstallString = [string]$_.UninstallString
        quietUninstallString = [string]$_.QuietUninstallString; registryPath = [string]$_.PSPath
      }
    }
}
$result | Sort-Object -Property name, version, publisher | ConvertTo-Json -Depth 4 -Compress
`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20000,
  });
  const raw = cleanText(stdout);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const deduped = new Map();
  for (const row of rows) {
    const program = {
      name: cleanText(row.name), version: cleanText(row.version), publisher: cleanText(row.publisher),
      installLocation: cleanText(row.installLocation), displayIcon: cleanIcon(row.displayIcon),
      estimatedSizeKB: Number(row.estimatedSizeKB) || 0, installDate: cleanText(row.installDate),
      uninstallString: cleanText(row.uninstallString), quietUninstallString: cleanText(row.quietUninstallString),
      registryPath: cleanText(row.registryPath),
    };
    if (!program.name) continue;
    const key = [program.name.toLowerCase(), program.version.toLowerCase(), program.publisher.toLowerCase()].join("|");
    if (!deduped.has(key)) deduped.set(key, program);
  }
  return [...deduped.values()];
}

async function discoverMacPrograms() {
  const roots = ["/Applications", path.join(os.homedir(), "Applications")];
  const programs = [];
  for (const root of roots) {
    let entries = [];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".app")) continue;
      const bundle = path.join(root, entry.name);
      const plist = path.join(bundle, "Contents", "Info.plist");
      let name = entry.name.replace(/\.app$/i, "");
      let version = "";
      try {
        const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", plist], { timeout: 3000 });
        name = cleanText(stdout) || name;
      } catch {}
      try {
        const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { timeout: 3000 });
        version = cleanText(stdout);
      } catch {}
      programs.push({ name, version, publisher: "", installLocation: bundle, estimatedSizeKB: 0, displayIcon: "", platform: "macOS" });
    }
  }
  return programs;
}

async function discoverLinuxPrograms() {
  const programs = [];
  try {
    const { stdout } = await execFileAsync("dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\t${Installed-Size}\t${Maintainer}\n"], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    for (const line of stdout.split(/\r?\n/)) {
      const [name, version, sizeKb, publisher] = line.split("\t");
      if (!name) continue;
      programs.push({ name, version: version || "", publisher: publisher || "", installLocation: "", estimatedSizeKB: Number(sizeKb) || 0, displayIcon: "", platform: "Linux" });
    }
  } catch {
    try {
      const { stdout } = await execFileAsync("rpm", ["-qa", "--qf", "%{NAME}\\t%{VERSION}\\t%{SIZE}\\t%{VENDOR}\\n"], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
      for (const line of stdout.split(/\r?\n/)) {
        const [name, version, size, publisher] = line.split("\t");
        if (!name) continue;
        programs.push({ name, version: version || "", publisher: publisher || "", installLocation: "", estimatedSizeKB: Math.round((Number(size) || 0) / 1024), displayIcon: "", platform: "Linux" });
      }
    } catch {}
  }
  return programs;
}

export async function discoverInstalledPrograms() {
  if (process.platform === "win32") return discoverWindowsPrograms();
  if (process.platform === "darwin") return discoverMacPrograms();
  if (process.platform === "linux") return discoverLinuxPrograms();
  return [];
}
