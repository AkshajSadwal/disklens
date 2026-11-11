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
$InstallerDir = Join-Path $Destination "installers\windows"
$Icon = Join-Path $Destination "assets\disklens.ico"
$StartVbs = Join-Path $InstallerDir "Start-DiskLens.vbs"
$StopVbs = Join-Path $InstallerDir "Stop-DiskLens.vbs"
$ShortcutDir = Join-Path ([Environment]::GetFolderPath("Programs")) "DiskLens"
New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
$Shell = New-Object -ComObject WScript.Shell

function New-DiskLensShortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Description, [string]$IconPath) {
  $shortcut = $Shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $Destination
  $shortcut.Description = $Description
  if (Test-Path -LiteralPath $IconPath) { $shortcut.IconLocation = "$IconPath,0" }
  $shortcut.Save()
}

$WScript = Join-Path $env:WINDIR "System32\wscript.exe"
New-DiskLensShortcut (Join-Path $ShortcutDir "DiskLens.lnk") $WScript "`"$StartVbs`"" "Start DiskLens in your browser" $Icon
New-DiskLensShortcut (Join-Path $ShortcutDir "Stop DiskLens.lnk") $WScript "`"$StopVbs`"" "Stop the local DiskLens services" $Icon
$Desktop = [Environment]::GetFolderPath("Desktop")
New-DiskLensShortcut (Join-Path $Desktop "DiskLens.lnk") $WScript "`"$StartVbs`"" "Start DiskLens in your browser" $Icon
Write-Host "DiskLens installed for the current Windows user. Use the Desktop icon or Start Menu > DiskLens."
Write-Host "A Stop DiskLens shortcut is available in the Start Menu. No administrator privileges were requested."
