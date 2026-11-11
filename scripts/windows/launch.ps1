$ErrorActionPreference = "Stop"

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
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root
& node scripts/launch.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
