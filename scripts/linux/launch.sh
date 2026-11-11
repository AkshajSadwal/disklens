#!/usr/bin/env sh
set -eu

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    [ "$major" -ge 22 ] && return
  fi
  command -v curl >/dev/null 2>&1 || { echo "curl is required to install the local Node.js runtime." >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "tar is required to install the local Node.js runtime." >&2; exit 1; }
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  platform="linux"
  runtime_root="${XDG_DATA_HOME:-$HOME/.local/share}/DiskLens/runtime"
  download_dir="$runtime_root/download"
  mkdir -p "$download_dir"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt" -o "$download_dir/SHASUMS256.txt"
  archive="$(awk -v a="$arch" '$2 ~ "node-v.*-linux-" a "\\.tar\\.xz$" {print $2; exit}' "$download_dir/SHASUMS256.txt")"
  [ -n "$archive" ] || { echo "Could not find an official Node.js archive for linux-$arch." >&2; exit 1; }
  expected="$(awk -v f="$archive" '$2 == f || $2 == "*" f {print $1; exit}' "$download_dir/SHASUMS256.txt")"
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$archive" -o "$download_dir/$archive"
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$download_dir/$archive" | awk '{print $1}')"; else actual="$(shasum -a 256 "$download_dir/$archive" | awk '{print $1}')"; fi
  [ "$actual" = "$expected" ] || { echo "Node.js archive checksum verification failed." >&2; exit 1; }
  folder="${archive%.tar.xz}"
  mkdir -p "$runtime_root"
  [ -x "$runtime_root/$folder/bin/node" ] || tar -xJf "$download_dir/$archive" -C "$runtime_root"
  PATH="$runtime_root/$folder/bin:$PATH"
  export PATH
  echo "Using DiskLens-managed Node.js runtime: $runtime_root/$folder"
}

ensure_node
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"
exec node scripts/launch.mjs
