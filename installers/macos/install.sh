#!/usr/bin/env sh
set -eu
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
DEST="$HOME/Applications/DiskLens"
mkdir -p "$HOME/Applications" "$DEST"
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
cat > "$HOME/Applications/DiskLens.command" <<COMMAND
#!/usr/bin/env sh
cd "$DEST"
exec "$DEST/scripts/macos/launch.sh"
COMMAND
chmod +x "$HOME/Applications/DiskLens.command" "$DEST/scripts/macos/launch.sh"
echo "DiskLens installed in $DEST. Double-click Applications/DiskLens.command to start it."
