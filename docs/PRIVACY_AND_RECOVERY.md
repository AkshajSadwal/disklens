# Privacy, security, backup, and recovery

## What DiskLens stores

DiskLens keeps its SQLite index and launcher state in the current user's application data directory:

- Windows: `%LOCALAPPDATA%\DiskLens`
- macOS: `~/Library/Application Support/DiskLens`
- Linux: `$XDG_DATA_HOME/DiskLens`, or `~/.local/share/DiskLens`

The index contains selected-root paths, file and folder names, sizes, modification timestamps, access status, scan history, and discovered program metadata. A normal scan does not read whole file contents. The collector excludes a set of common credential directories, environment files, and private-key formats; exclusions cannot identify every sensitive file. The app database should therefore be treated as private user data.

AI provider settings contain non-secret provider/model/endpoint metadata. Saved provider credentials use Windows DPAPI, macOS Keychain, or Linux Secret Service when available. If the system store is unavailable, Settings can store a passphrase-encrypted local credential using scrypt and AES-256-GCM. The passphrase is never persisted; the decrypted key stays in server memory for at most 15 minutes and must be unlocked again after restart. Settings APIs do not return key values. Environment-based keys in `.env` remain supported. Protect the local config directory, `.env` file, and credential-store access from other users.

## Hosted AI data flow

Hosted AI is optional. DiskLens does not call a provider during scans, startup, or ordinary browsing. A request is made only after a user invokes an AI analysis action while a provider is configured. For hosted file analysis, DiskLens removes full paths, file names, file contents, and file hashes from the evidence, and limits the request size. Storage advice can include aggregate size/category information and program names. The request and response are subject to the selected provider's retention, privacy, and billing terms. Review provider configuration and terms before enabling it. Local rules continue to work without network access.

Before a hosted advisor or file-safety request, the interface previews the exact JSON request body the provider adapter will send, including its response schema, model, and output cap, plus an approximate token count. Authorization headers are never included in the preview. The preview is held in memory for five minutes and can be used once. Do not use hosted AI if even minimized metadata or program names must remain local.

## Threat model and safe use

- **Local access:** the API and UI bind to loopback by default. Browser requests are accepted only from the exact UI origin chosen by the launcher; requests with no `Origin` header remain available to local scripts and the collector. Other processes running as the same user may still access local application data or the local HTTP service. Keep the OS user account protected and do not expose the service through a reverse proxy or LAN bind without adding authentication.
- **Filesystem permissions:** scans do not elevate privileges. Inaccessible entries are skipped and summarized. Symlink directories are not traversed. A scan is an inventory, not proof that every file on a volume was indexed.
- **AI output:** provider recommendations can be wrong. They are informational and cannot invoke deletion.
- **Cleanup:** inspect selected paths and the confirmation dialog. Trash/recycle is preferred where supported. Permanent deletion cannot be undone. DiskLens path guards reduce risk but do not replace review.
- **Credential exclusions:** matching rules reduce accidental indexing; they are not a complete secret scanner. Avoid selecting roots that contain data you do not want indexed.
- **Updates and installers:** source installers are unsigned. Obtain project files from a trusted source and review changes before updating. The runtime bootstrap verifies the downloaded Node archive against the checksum list fetched from nodejs.org; it is not a signed DiskLens release.

## Back up and restore

1. Close DiskLens fully so SQLite has flushed its journal/WAL and no scan is active.
2. Copy the entire per-user `DiskLens` data directory listed above to an access-controlled backup location. This includes the database and launcher state.
3. Keep backups encrypted or otherwise protected like the original index. The index may reveal private names and folder structure.
4. To restore, close DiskLens, preserve a copy of the current data directory, then restore the backup directory to the same per-user location. Start DiskLens and confirm the expected roots and scan history appear.
5. If the restored database cannot be opened, close the app and restore the preserved pre-restore directory. Do not run migrations or diagnostics against the only copy of a valuable database.

The operating-system credential store is outside this data directory. Encrypted fallback credentials live in the DiskLens config directory and require the original passphrase after restore. Reinstalling or restoring only the database does not restore saved AI keys; configure them again in Settings if needed. Keep `.env` backups separate and protected if using environment-based keys.

## Troubleshooting

- **App will not start:** close any existing DiskLens process, then start it from the installed shortcut/command so startup errors remain visible. Confirm outbound access to `nodejs.org` is available if the launcher needs to bootstrap Node, and confirm the user profile has enough space for runtime and dependencies.
- **Browser did not open:** use the `http://127.0.0.1` URL printed in the launcher terminal. On Linux, automatic opening requires a desktop session and `xdg-open`.
- **A folder is missing from results:** check the scan's skipped/partial summary and the selected root. DiskLens does not bypass permissions or follow directory symlinks. Run a new scan after access or folder contents change.
- **Trash/recycle action fails:** Linux requires `gio` or `trash-put` and a working desktop trash. Review the reported path; permanent delete is a separate choice with a stronger consequence.
- **AI key cannot be saved:** confirm the OS credential service is running (Keychain on macOS, Secret Service and `secret-tool` on Linux). Otherwise enter a local encryption passphrase in Settings or configure the protected server `.env` file. The key is intentionally not saved as plaintext by Settings.
- **Provider test fails:** the test requests the provider's model list and does not generate text. Check endpoint, key, model availability, and network access. A successful test does not guarantee that later analysis is within provider quota.
- **Need to inspect database selection:** use the read-only `npm run diagnose` command from `server` with `DISKLENS_DB_PATH` set to the intended database. See the README example; do not point diagnostics at an unknown production copy without preserving it first.
