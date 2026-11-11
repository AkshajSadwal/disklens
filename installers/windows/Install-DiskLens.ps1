$ErrorActionPreference = "Stop"
$Source = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
$Destination = Join-Path $LocalAppData "Programs\DiskLens"
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$arguments = @($Source, $Destination, "/E", "/XD", ".git", "node_modules", ".next", "dist", "build", "/XF", ".env", ".env.*", ".envrc", ".npmrc", ".pypirc", ".git-credentials", "*.zip")
robocopy @arguments | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Could not copy DiskLens project files (robocopy $LASTEXITCODE)." }
# Restore the public examples after excluding all local environment files.
foreach ($relative in @(".env.example", "server\.env.example", "frontend\.env.example")) {
  $from = Join-Path $Source $relative
  if (Test-Path $from) {
    $to = Join-Path $Destination $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
    Copy-Item -Force $from $to
  }
}
$Launcher = Join-Path $Destination "scripts\windows\launch.ps1"
$ShortcutDir = Join-Path ([Environment]::GetFolderPath("Programs")) "DiskLens"
New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
$ShortcutPath = Join-Path $ShortcutDir "DiskLens.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = (Get-Command powershell.exe).Source
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""
$Shortcut.WorkingDirectory = $Destination
$Shortcut.Description = "Start local DiskLens storage analyzer"
$Shortcut.Save()
Write-Host "DiskLens installed for the current Windows user. Start it from the Start Menu > DiskLens."
Write-Host "No administrator privileges were requested."
