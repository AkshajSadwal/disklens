param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$Stage = [IO.Path]::GetFullPath($OutputDirectory)
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must be a stable semantic version, such as 1.0.0."
}
if ($Stage.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
  throw "OutputDirectory must be outside the source tree."
}
if (-not (Test-Path (Join-Path $Root "server/node_modules/better-sqlite3/package.json"))) {
  throw "Server dependencies are missing. Run npm ci in server first."
}
if (-not (Test-Path (Join-Path $Root "frontend/node_modules/next/package.json"))) {
  throw "Frontend dependencies are missing. Run npm ci in frontend first."
}
if (-not (Test-Path (Join-Path $Root "frontend/.next/BUILD_ID"))) {
  throw "Frontend production build is missing. Run npm run build in frontend first."
}

Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

function Copy-ProjectTree([string]$Source, [string]$Destination, [string[]]$ExcludedDirectories, [string[]]$ExcludedFiles) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $copyArgs = @($Source, $Destination, "/E", "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
  if ($ExcludedDirectories.Count -gt 0) { $copyArgs += "/XD"; $copyArgs += $ExcludedDirectories }
  if ($ExcludedFiles.Count -gt 0) { $copyArgs += "/XF"; $copyArgs += $ExcludedFiles }
  & robocopy.exe @copyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Failed to stage $Source (robocopy exit $LASTEXITCODE)." }
}

Copy-ProjectTree (Join-Path $Root "server") (Join-Path $Stage "server") @((Join-Path $Root "server/coverage")) @(".env", ".env.*", "*.db", "*.db-shm", "*.db-wal", "*.sqlite", "*.sqlite3", "*.log")
Copy-ProjectTree (Join-Path $Root "frontend") (Join-Path $Stage "frontend") @((Join-Path $Root "frontend/.next/cache"), (Join-Path $Root "frontend/coverage")) @(".env", ".env.*", ".envrc", "*.local", "*.log")
Copy-ProjectTree (Join-Path $Root "collector") (Join-Path $Stage "collector") @() @(".env", ".env.*", "*.log")
Copy-ProjectTree (Join-Path $Root "shared") (Join-Path $Stage "shared") @() @(".env", ".env.*", "*.log")
Copy-ProjectTree (Join-Path $Root "assets") (Join-Path $Stage "assets") @() @()
Copy-ProjectTree (Join-Path $Root "installers/windows") (Join-Path $Stage "installers/windows") @() @("*.iss")
Copy-ProjectTree (Join-Path $Root "scripts/windows") (Join-Path $Stage "scripts/windows") @() @("*.log")
foreach ($file in @("launch.mjs", "first-run.mjs", "frontendCommand.mjs")) {
  Copy-Item -LiteralPath (Join-Path $Root "scripts/$file") -Destination (Join-Path $Stage "scripts/$file") -Force
}
Copy-Item -LiteralPath (Join-Path $Root ".env.example") -Destination (Join-Path $Stage ".env.example") -Force

# Bundle the exact Node.js patch version used to install native dependencies,
# so better-sqlite3 and the portable runtime share the same ABI.
$buildNodeVersion = (& node -p "process.versions.node").Trim()
$runtimeBase = "https://nodejs.org/dist/v$buildNodeVersion/"
$archiveName = "node-v$buildNodeVersion-win-x64.zip"
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$download = Join-Path $tempRoot "disklens-node-runtime"
New-Item -ItemType Directory -Force -Path $download | Out-Null
$checksumsPath = Join-Path $download "SHASUMS256.txt"
Invoke-WebRequest -Uri ($runtimeBase + "SHASUMS256.txt") -OutFile $checksumsPath
$checksumsText = Get-Content -LiteralPath $checksumsPath -Raw
$checksumLine = ($checksumsText -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($archiveName) } | Select-Object -First 1)
if (-not $checksumLine) { throw "Node.js archive checksum entry is missing." }
$expectedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
$archivePath = Join-Path $download $archiveName
Invoke-WebRequest -Uri ($runtimeBase + $archiveName) -OutFile $archivePath
$actualHash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToUpperInvariant()
if ($actualHash -ne $expectedHash) { throw "Node.js runtime SHA-256 verification failed." }
$extractPath = Join-Path $download "extract"
Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
$runtimeFolder = Join-Path $extractPath ([IO.Path]::GetFileNameWithoutExtension($archiveName))
$runtimeDestination = Join-Path $Stage "runtime"
New-Item -ItemType Directory -Force -Path $runtimeDestination | Out-Null
Copy-Item -Path (Join-Path $runtimeFolder "*") -Destination $runtimeDestination -Recurse -Force
if (-not (Test-Path (Join-Path $runtimeDestination "node.exe")) -or -not (Test-Path (Join-Path $runtimeDestination "node_modules/npm/bin/npm-cli.js"))) {
  throw "Bundled Node.js runtime is incomplete (node.exe/npm missing)."
}
$nodeVersion = (& (Join-Path $runtimeDestination "node.exe") --version).Trim()
Set-Content -LiteralPath (Join-Path $Stage "VERSION.txt") -Value "DiskLens $Version`nBundled runtime: Node.js $nodeVersion`nArchitecture: Windows x64`n"
Write-Host "Prepared Windows release in $Stage using $nodeVersion."
