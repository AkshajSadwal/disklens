$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 20 or newer is required. Install from https://nodejs.org/ and rerun."
  exit 1
}
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root
node scripts/launch.mjs
