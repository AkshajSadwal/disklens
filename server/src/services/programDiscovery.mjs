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

export async function discoverInstalledPrograms() {
  const script = String.raw`
$roots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

$skipReleaseTypes = @('Security Update', 'Update', 'Hotfix', 'Service Pack', 'Feature Pack')

$result = foreach ($root in $roots) {
  Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
    Where-Object {
      $_.DisplayName -and
      $_.SystemComponent -ne 1 -and
      $_.ReleaseType -notin $skipReleaseTypes -and
      $_.ParentKeyName -eq $null
    } |
    ForEach-Object {
      [PSCustomObject]@{
        name = [string]$_.DisplayName
        version = [string]$_.DisplayVersion
        publisher = [string]$_.Publisher
        installLocation = [string]$_.InstallLocation
        displayIcon = [string]$_.DisplayIcon
        estimatedSizeKB = if ($null -ne $_.EstimatedSize) { [int64]$_.EstimatedSize } else { 0 }
        installDate = [string]$_.InstallDate
        uninstallString = [string]$_.UninstallString
        quietUninstallString = [string]$_.QuietUninstallString
        registryPath = [string]$_.PSPath
      }
    }
}

$result |
  Sort-Object -Property name, version, publisher |
  ConvertTo-Json -Depth 4 -Compress
`;

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  const raw = cleanText(stdout);
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const deduped = new Map();

  for (const row of rows) {
    const program = {
      name: cleanText(row.name),
      version: cleanText(row.version),
      publisher: cleanText(row.publisher),
      installLocation: cleanText(row.installLocation),
      displayIcon: cleanIcon(row.displayIcon),
      estimatedSizeKB: Number(row.estimatedSizeKB) || 0,
      installDate: cleanText(row.installDate),
      uninstallString: cleanText(row.uninstallString),
      quietUninstallString: cleanText(row.quietUninstallString),
      registryPath: cleanText(row.registryPath),
    };

    if (!program.name) continue;

    const key = [
      program.name.toLowerCase(),
      program.version.toLowerCase(),
      program.publisher.toLowerCase(),
    ].join("|");

    if (!deduped.has(key)) {
      deduped.set(key, program);
    }
  }

  return [...deduped.values()];
}
