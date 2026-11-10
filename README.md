# DiskLens

DiskLens is a local-first storage index and explorer. It consists of a Next.js frontend, Fastify/SQLite server, and filesystem collector.

## Requirements for running from source

- Node.js 20 or newer
- npm
- A supported desktop browser
- Permission to read the locations the user explicitly selects

The source launcher installs missing npm dependencies, creates `server/.env` from `.env.example` when needed, selects available localhost ports, starts the backend and frontend, checks their health, and opens the browser.

### Windows
Run PowerShell:
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\launch.ps1
```

### Linux
```sh
chmod +x scripts/linux/launch.sh
./scripts/linux/launch.sh
```

### macOS
```sh
chmod +x scripts/macos/launch.sh
./scripts/macos/launch.sh
```

Stop the services with Ctrl+C in the launcher terminal.

## AI providers

AI is optional. If no provider key is configured, DiskLens runs its deterministic local rule-based analysis and labels the result as `local-rules`.

Configure keys in `server/.env` (never commit this file):
```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Legacy Azure OpenAI remains supported:
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_REASONING_EFFORT=high
```

Provider precedence is OpenAI, then Anthropic, then legacy Azure OpenAI. If a configured provider fails, the request falls back to local rule-based analysis. Hosted requests send only the evidence already selected by the existing AI services; do not put secrets or private file contents in scanned paths. API usage may incur provider charges.

## Collector

The collector scans only roots explicitly passed by the user. It uploads metadata in batches and does not upload complete file contents. Examples:

```powershell
cd collector
npm install
node src/index.mjs "C:\Users\YourName\Downloads"
```

```sh
cd collector
npm install
node src/index.mjs "$HOME/Downloads"
```

Ctrl+C requests a graceful stop and flushes the current batch. Since the scanner does not know the total number of entries before traversing, it reports actual scanned/uploaded/skipped counts and throughput rather than inventing a percentage or ETA.

## Data and privacy

- SQLite database: `server/disklens.db`
- Local AI rules require no network/API key.
- Hosted AI providers receive selected evidence only when configured and invoked.
- Keep `server/.env` private. `.env.example` contains empty placeholders only.
- Do not run DiskLens with elevated privileges unless a specific scan requires it and you understand why.

## Important platform limitations

This release adds cross-platform filesystem capacity metadata and source launch scripts, but it is **not yet a fully packaged consumer installer**. The launcher requires Node.js 20+ and npm to already be installed. It does not silently install runtimes or request administrator/root privileges.

The existing program discovery, Recycle Bin integration, Windows digital-signature inspection, and some Explorer-opening/deletion operations remain Windows-specific. Linux and macOS have not been certified for feature parity. No Windows MSI/EXE, Linux AppImage/DEB/RPM, or signed macOS DMG is produced by this source ZIP. Those require platform-specific build/signing machines and verification.

## Validation

See `TEST_REPORT.md` for checks run in the build environment and items that still require native OS testing.
