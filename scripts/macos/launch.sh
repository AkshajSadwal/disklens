#!/usr/bin/env sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install from https://nodejs.org/ and rerun."
  exit 1
fi
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"
node scripts/launch.mjs
