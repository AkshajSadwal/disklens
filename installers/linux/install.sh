#!/usr/bin/env sh
set -eu
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
DEST="$HOME/.local/opt/DiskLens"
mkdir -p "$DEST"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --exclude='.git' --exclude='node_modules' --exclude='.next' --include='.env.example' --exclude='.env' --exclude='.env.*' --exclude='.envrc' --exclude='.npmrc' --exclude='.pypirc' --exclude='.git-credentials' --exclude='*.zip' "$SOURCE/" "$DEST/"
else
  tar -C "$SOURCE" --exclude='.git' --exclude='node_modules' --exclude='.next' --exclude='.env' --exclude='.env.*' --exclude='.env.development*' --exclude='.env.production*' --exclude='.env.test*' --exclude='.env.staging*' --exclude='.env.preview*' --exclude='.envrc' --exclude='.npmrc' --exclude='.pypirc' --exclude='.git-credentials' --exclude='*.zip' -cf - . | tar -C "$DEST" -xf -
fi
# Preserve public configuration examples while never copying local API keys.
for relative in .env.example server/.env.example frontend/.env.example; do
  if [ -f "$SOURCE/$relative" ]; then
    mkdir -p "$DEST/$(dirname "$relative")"
    cp "$SOURCE/$relative" "$DEST/$relative"
  fi
done
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/disklens.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=DiskLens
Comment=Local storage analyzer
Exec="$DEST/scripts/linux/launch.sh"
Terminal=true
Categories=Utility;System;
DESKTOP
chmod +x "$DEST/scripts/linux/launch.sh" "$HOME/.local/share/applications/disklens.desktop"
echo "DiskLens installed in $DEST. Open DiskLens from your application menu."
