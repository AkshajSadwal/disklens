$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$dataDirectory = Join-Path $env:LOCALAPPDATA "DiskLens"
$lockPath = Join-Path $dataDirectory "launcher.lock"
if (-not (Test-Path -LiteralPath $lockPath)) {
  [System.Windows.Forms.MessageBox]::Show("DiskLens is not running.", "DiskLens", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
  exit 0
}
try {
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  $processId = [int]$lock.pid
  if ($processId -le 0) { throw "Invalid launcher process id." }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if (-not $process -or $process.CommandLine -notmatch 'scripts[\\/]launch\.mjs') {
    [System.Windows.Forms.MessageBox]::Show("DiskLens is not running. A stale launcher lock will be cleared on the next start.", "DiskLens", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    exit 0
  }
  & taskkill.exe /PID $processId /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Windows could not stop the DiskLens process tree (exit $LASTEXITCODE)." }
  [System.Windows.Forms.MessageBox]::Show("DiskLens has been stopped.", "DiskLens", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
} catch {
  [System.Windows.Forms.MessageBox]::Show("Could not stop DiskLens: $($_.Exception.Message)", "DiskLens", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
  exit 1
}
