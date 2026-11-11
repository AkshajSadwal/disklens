# DiskLens

DiskLens is a local-first storage index and explorer. The application has a Next.js UI, a Fastify API backed by SQLite, and a separate filesystem collector. It stores file and folder metadata locally; it does not upload complete files during a normal scan.

## What this release includes

- Home dashboard, Storage Explorer, Largest Items, Programs & Cleanup, AI Storage Advisor, and the existing file-analysis flow.
- Largest Items tabs for Files, Folders, and Programs. Program sizes use indexed bytes under a detected install location when available; otherwise they are clearly identified as package-manager or Windows registry estimates.
- AI support for OpenAI and Anthropic Claude, with legacy Azure OpenAI support. If no provider is configured or a configured provider fails, deterministic local rules still return analysis and are identified as `local-rules`.
- An explicit first-run folder/drive chooser. Nothing is scanned until the user selects locations and types `YES`.
- A live estimate phase followed by a progress bar based on a real item count, upload count, skipped/partial count, elapsed time, and ETA. Ctrl+C and the in-app Cancel action request a safe stop.
- Staged scans: the previous completed index remains visible unless a replacement scan completes. A completed empty-folder scan correctly clears the old contents for that root.
- Retry handling for temporary upload/network failures, privacy exclusions for common credential stores/private keys, and no symlink directory traversal.
- A localhost-only launcher that checks backend health, selects available ports, opens the browser, and prevents a second launcher instance.
- Per-user install/launch scripts for Windows, Linux, and macOS. If Node.js 20+ is not installed, the launcher downloads an official Node.js 24 runtime into the user's DiskLens data folder and verifies the archive SHA-256 against the official Node.js checksum file. It does not request administrator/root privileges.

## Install and launch

The installer scripts install the project files for the current user. Close any running DiskLens instance before installing an update. If the source project still contains its legacy `server/disklens.db`, the installer carries it into the installed folder so the launcher can migrate it into the per-user data directory. Local `.env` files and credentials are excluded; only `.env.example` templates are copied. The first launch prepares dependencies, creates a private local configuration file from `.env.example`, and opens the first-run scan chooser.

### Windows 10 / 11

1. Extract the ZIP.
2. Open `installers\\windows` and double-click `Install-DiskLens.bat`.
3. Start **DiskLens** from the Start Menu. The launcher will bootstrap Node.js if needed and then prepare the app.

The PowerShell installer writes to `%LOCALAPPDATA%\\Programs\\DiskLens`; its launcher and runtime stay under the current user's profile.

### Linux

From the extracted project folder, run:

```sh
sh installers/linux/install.sh
```

This copies the project into `~/.local/opt/DiskLens` and creates a desktop entry. Open DiskLens from the application menu. A desktop environment and `xdg-open` are needed for automatic browser opening; otherwise the launcher prints the local URL.

### macOS (Intel and Apple Silicon)

From the extracted project folder, run:

```sh
sh installers/macos/install.sh
```

This copies the project into `~/Applications/DiskLens` and creates `~/Applications/DiskLens.command`. Double-click that command file to start the app. macOS may ask you to confirm running a downloaded script depending on your Gatekeeper settings.

### First-run scan

The first launch displays the OS/architecture, available memory, suggested locations, and free space where it can be read. Enter one or more absolute folder/drive paths separated by semicolons. Review the list and type `YES` to confirm. Press Enter to skip; you can add a folder later from Quick Actions using the native folder picker, then scan or rescan it from the app. No automatic full-disk scan is performed without confirmation.

During scanning, the collector first counts accessible entries (an estimate phase), then displays real progress and ETA. The scan does not read whole files as part of indexing. Credential-related folders/files and private-key formats are omitted, and directory symlinks are not traversed. Permission failures are skipped and summarized. Ctrl+C or Cancel stops the active scan; incomplete staging data is discarded and the previous completed index is retained.

## AI configuration (optional)

No AI key is required. Without a key, the AI panels use built-in deterministic rules and show `local-rules` as the source. OpenAI is preferred if both OpenAI and Anthropic keys are set; otherwise Anthropic is used. Legacy Azure OpenAI is checked after those providers. Provider/network errors fall back to the local rules rather than disabling analysis.

To enable a hosted provider, edit `server/.env` after the first launch:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Optional legacy Azure OpenAI configuration:
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_REASONING_EFFORT=high
```

Keep `server/.env` private. Do not commit or share it. Hosted AI calls occur only when an AI analysis action is invoked and a provider is configured. The existing file analyzer may send selected evidence such as a bounded text sample, metadata, and signature/hash information to that provider; it does not send every scanned file. Review the evidence and your provider's billing/privacy terms before enabling a key. API usage can incur charges.

## Data locations

DiskLens keeps its SQLite index and launcher state in the current user's application data directory:

- Windows: `%LOCALAPPDATA%\\DiskLens`
- macOS: `~/Library/Application Support/DiskLens`
- Linux: `$XDG_DATA_HOME/DiskLens`, or `~/.local/share/DiskLens`

An existing `server/disklens.db` from an earlier source-run installation is copied to this location at launch when no user data database exists. The database schema is migrated automatically. A copy of the database is not added to this ZIP.

## Developer / source launch

Requirements: Node.js 20+ and npm. From the project root:

```sh
node scripts/launch.mjs
```

The launcher installs dependencies from the lockfiles on first run. Stop both services with Ctrl+C in the launcher terminal. To run only the collector against an already-running API, use:

```sh
node collector/src/index.mjs "/absolute/path/to/scan"
```

The server defaults to port 4000 and the frontend to port 3000 when launched directly; `scripts/launch.mjs` selects free ports and passes them to both services. Both bind to loopback (`127.0.0.1`); they are not exposed to the LAN by default.

## Configuration reference

The root `.env.example` and `server/.env.example` contain empty optional AI key fields and local service defaults. `frontend/.env.example` contains the local API URL template. The launcher creates `server/.env` only if it does not already exist. `DISKLENS_PORT` and `NEXT_PUBLIC_DISKLENS_API` are set by the launcher when it chooses dynamic ports.

## Safety and limitations

- A scan indexes names, paths, timestamps, sizes, and access status; it does not store complete file contents.
- Credential stores and private-key files are excluded by name/location/extension rules. These rules reduce unnecessary collection but cannot guarantee recognition of every secret file.
- File analysis reads bounded evidence for the selected file only. When a hosted provider is configured, that evidence may be sent to the provider.
- Directory symlinks are not followed. The collector does not elevate privileges to bypass access controls.
- Delete operations are separate from scanning. The existing confirmation UI remains required; recycle/trash is preferred, and permanent deletion must be explicitly selected. Filesystem roots and common OS directories are protected. An OS trash utility is required for trash-based deletion on Linux.
- Runtime bootstrap and source installers are provided, not signed native packages. This ZIP does not contain a Windows MSI/EXE installer, Linux DEB/RPM/AppImage, or signed/notarized macOS DMG. Those require native build and signing environments.
- Windows has not been executed in this build environment. Linux/macOS installers have not been end-to-end run on their target desktop systems here. See `TEST_REPORT.md` for exactly what was and was not validated.

## Documentation

- `TEST_REPORT.md` — automated checks, build/install limitations, and native-platform verification still required.
- `MIGRATE_FROM_CURRENT.md` — safe upgrade steps for an existing working copy.


## Check which database DiskLens is using

From the `server` directory, set `DISKLENS_DB_PATH` to the database you want to inspect and run:

```powershell
$env:DISKLENS_DB_PATH = "A:\\disklens-starter\\server\\disklens.db"
npm run diagnose
```

The diagnostic is read-only. It reports the database file size, indexed item counts, indexed roots, drive metadata, and recent scan runs. It does not migrate, modify, or rescan the database.
