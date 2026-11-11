$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$BundledNode = Join-Path $Root "runtime\node.exe"
$DataDirectory = Join-Path $env:LOCALAPPDATA "DiskLens"
$LogDirectory = Join-Path $DataDirectory "logs"
$LogPath = Join-Path $LogDirectory "launcher.log"
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 2MB) {
  Move-Item -Force $LogPath (Join-Path $LogDirectory "launcher.previous.log")
}

function Invoke-DiskLens([string]$NodeCommand, [string]$LauncherScript) {
  Set-Location $Root
  & $NodeCommand $LauncherScript *>> $LogPath
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "DiskLens could not start (exit $exitCode). See the startup log at:`n$LogPath",
      "DiskLens startup error",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit $exitCode
  }
}

if (Test-Path -LiteralPath $BundledNode) {
  # Release installs always use the bundled runtime because native modules
  # (notably better-sqlite3) were installed for this exact Node ABI.
  $env:PATH = "$(Split-Path -Parent $BundledNode);$env:PATH"
  $env:DISKLENS_PRODUCTION = "1"
  Invoke-DiskLens $BundledNode (Join-Path $Root "scripts\launch.mjs")
  exit 0
}

function Ensure-NodeRuntime {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    try {
      $versionText = (& node -p "process.versions.node").Trim()
      if ([version]$versionText -ge [version]"22.0.0") { return }
    } catch {}
  }

  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $runtimeRoot = Join-Path $localAppData "DiskLens\runtime"
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
  $downloadDir = Join-Path $runtimeRoot "download"
  New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
  $checksums = Join-Path $downloadDir "SHASUMS256.txt"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -OutFile $checksums
  $archive = (Get-Content $checksums | Where-Object { $_ -match "\s+node-v[0-9.]+-$arch\.zip$" } | Select-Object -First 1) -replace '^\s*[0-9a-fA-F]+\s+\*?', ''
  if (-not $archive) { throw "Could not find an official Node.js archive for $arch." }
  $archiveName = $archive.Trim()
  $checksumLine = Get-Content $checksums | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1
  $expectedHash = ($checksumLine -split "\s+")[0]
  $archivePath = Join-Path $downloadDir $archiveName
  Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v24.x/$archiveName" -OutFile $archivePath
  $actualHash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash
  if ($actualHash -ne $expectedHash) { throw "Node.js archive checksum verification failed." }

  $folderName = [IO.Path]::GetFileNameWithoutExtension($archiveName)
  $target = Join-Path $runtimeRoot $folderName
  if (-not (Test-Path (Join-Path $target "node.exe"))) {
    Remove-Item -Recurse -Force $target -ErrorAction SilentlyContinue
    $extract = Join-Path $downloadDir "extract"
    Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
    Expand-Archive -Path $archivePath -DestinationPath $extract -Force
    Move-Item -Force (Join-Path $extract $folderName) $target
  }
  $env:PATH = "$target;$env:PATH"
  Write-Host "Using DiskLens-managed Node.js runtime: $target"
}

Ensure-NodeRuntime
Invoke-DiskLens "node" (Join-Path $Root "scripts\launch.mjs")
