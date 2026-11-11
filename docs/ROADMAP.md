# DiskLens product roadmap

## Product direction

DiskLens is a portfolio-quality, local-first storage intelligence application for Windows, macOS, and Linux. The default experience works offline. Hosted AI is optional and is enabled only when the user explicitly configures a provider in the local Settings page and chooses an AI action.

## Phase 1 — Scan and index reliability (implemented; native validation pending)

**Goal:** trust the index before expanding product features.

- [x] Stage each scan and replace the visible index only after a successful completion.
- [x] Preserve the previous completed index when a scan is cancelled or interrupted.
- [x] Report estimated and live progress, uploaded counts, skipped counts, per-location status, elapsed time, and a rough ETA when measurable.
- [x] Send cancellation to the collector over a control pipe rather than relying only on child-process signals.
- [x] Exclude common credential directories, environment files, and private-key artifacts.
- [x] Avoid traversing symbolic-link directories and reject symbolic-link scan roots.
- [x] Deduplicate equivalent scan roots and reject nested/overlapping roots, including case-insensitive Windows path comparisons.
- [x] Preserve final per-root outcomes for a multi-location scan so a queued location cannot be mistaken for a previous completed scan.
- [x] On server shutdown, request collector cancellation, wait for exit, and clean unfinished staging rows before closing SQLite.
- [x] Add focused tests for estimation cancellation, upload cancellation, inaccessible roots, empty roots, progress, host-native path handling, root overlap, and multi-root outcome classification.
- [x] Run a live localhost API smoke test on Windows using a temporary database and two disposable folders; verify both roots, indexed counts, and an unchanged repeat-scan fingerprint.
- [ ] Manually verify cancellation during estimation/upload and backend restart during an active scan on Windows 11.
- [ ] Verify an existing 500k+ item index remains queryable after applying the update; do not use a full-drive rescan as a test.
- [ ] Repeat a short smoke test on macOS and Linux before declaring cross-platform scan support complete.

**Exit criteria:** every test scenario ends in a clear terminal state; cancellation never commits staging data; the last good index remains available; progress does not remain stuck after an error or shutdown.

## Phase 2 — Local AI provider settings and cost controls (implemented with provider scope limits)

**Goal:** let users configure AI from `http://localhost` without editing source files.

- [x] Enable Settings in the sidebar and add an AI Provider section.
- [x] Support local rules (default), OpenAI, Anthropic, Azure OpenAI v1, and OpenAI-compatible chat-completions endpoints.
- [x] Provider fields include API key and model/deployment; compatible endpoints accept a base URL and Azure accepts a resource endpoint. Azure v1 uses implicit API versioning.
- [x] Add Test Connection (models-list request, no generation), Save, and Remove Key actions.
- [x] Keep keys on the server only. Settings responses expose only whether a key is configured.
  - [x] Store secrets using Windows DPAPI, macOS Keychain, or Linux Secret Service (`secret-tool`), with an opt-in scrypt/AES-256-GCM encrypted local fallback when the OS store is unavailable. The fallback passphrase is not persisted; decryption remains in memory for at most 15 minutes and requires unlock after restart.
  - [x] Keep macOS provider keys out of the `security` process arguments by using its stdin command mode with hex input; verify the saved Keychain value before returning success.
- [x] Keep `.env` configuration as a backwards-compatible fallback.
- [x] Restrict browser API access to the exact loopback UI origin selected by the launcher; reject other `Origin` headers at the API while preserving local no-Origin scripts.
- [x] Hosted analysis only runs after an explicit AI action; provider/source is shown and bounded input/output limits, timeouts, and local-rules fallback are applied.

## Phase 3 — Storage Explorer (core search and filters implemented)

- [x] Fast indexed prefix search by name or path, with pagination and cancellation/debounce.
- [x] Filter by file/folder, extension, size range, and modified date.
- [x] Sort by size, name, and modified time with stable ordering.
- [x] Current-folder scope and path navigation, with empty/error/loading states.
- [x] Explain the difference between physical drive usage and the sum of indexed file sizes.
- [x] Add browser-local saved filters and a capped exportable CSV report (10,000 rows maximum).
- [x] Use case-insensitive indexed path prefixes on Windows and case-sensitive indexed prefixes on POSIX systems.

## Phase 4 — Safe cleanup and duplicate analysis (review flow implemented)

- [x] Find exact duplicates using size as a prefilter and hash only after explicit user request with file-count and byte bounds.
- [x] Add temporary/cache and large-old-file candidate groups with path-safety exclusions.
- [x] Show estimated recoverable space and selection reasons; the estimate is labeled as a review aid.
- [x] Preview selected items and require confirmation through the existing delete dialog.
- [x] Prefer OS Recycle Bin/Trash and distinguish permanent deletion.
- [x] Protect unsafe OS/system paths; only indexed candidates are offered.
- [x] Bound requests and report individual deletion outcomes.
- [x] Maintain a durable user-visible cleanup action history with per-item outcomes.
- [x] Refuse file deletion when size or modification time changed since the last scan.
- [x] Add a Windows Restart Manager preflight that checks files recursively in selected folders (up to 2,000 paths), reports partial/unsupported checks honestly, and requires explicit review when another process holds a file open.

## Phase 5 — AI Storage Advisor (privacy controls implemented)

- [x] Keep deterministic local recommendations available offline.
- [x] Explain suggestions using indexed facts.
- [x] Strip full paths, file names, content samples, and file hashes from hosted file evidence; bound hosted payload size.
- [x] Bound candidate count/output and fall back on provider/network/quota/timeout errors.
- [x] AI does not perform deletion or other destructive actions.
- [x] Add an in-app preview of the exact provider JSON request body (without authorization headers), provider/model, output cap, and approximate token count before sending. Preview snapshots expire after five minutes and are one-use.

## Phase 6 — Incremental indexing and performance (partial)

- [x] Store a SHA-256 fingerprint for each fully accessible completed root snapshot and report whether it matches the previous comparable snapshot; fingerprints cover path and metadata only, never file contents. Incomplete/access-limited snapshots are excluded from fingerprint comparisons.
- [x] Skip database diff and reconciliation queries when the latest completed snapshot has the same trusted fingerprint; partial scans and successful deletes invalidate that shortcut so a later full scan still reconciles the index.
- [x] Reuse the previous indexed item count as a provisional estimate on repeat scans, skipping the separate directory-count walk while still enumerating and reading metadata for every current entry; correct the estimate to the observed count at completion.
- [ ] Add filesystem-level incremental refresh only after correctness is proven against a full-scan fixture. Current scans still enumerate the full selected tree; commit preserves unchanged database rows and inaccessible subtrees.
- [x] Add indexes for exercised search/lookup paths and retain unchanged indexed row IDs during commit.
- [x] Stream per-directory entries with a 32-entry filesystem buffer and keep upload batches sequential and fixed-size (250 items).
- [x] Read entry metadata through a fixed 16-entry concurrent window while applying results in directory order; upload batches and progress updates remain sequential.
- [x] Bound the in-memory directory frontier and spill unusually broad scan queues to a temporary file; filesystem entries and upload batches remain bounded and sequential.
- [x] Avoid a separate open/close probe for every child directory; verify queued entries immediately before traversal and record access failures through staged metadata.
- [x] Count traversal-time directory failures as skipped items and persist the updated progress after preserving the old subtree.
- [ ] Add stronger end-to-end correctness and resource checks for very large directory trees before raising the default in-memory queue limit.
- [x] Expose bounded recent scan history and preserve per-root scan outcomes.
- [x] Store indexed-byte totals per completed scan and show recent trends without retaining per-file history.
- [x] Record per-scan added, changed, unchanged, removed, and access-preserved item counts in scan history.

## Phase 7 — Cross-platform release readiness (documentation and launchers ready; native release validation pending)

- [ ] Test current supported Node.js LTS versions on Windows 10/11, macOS Intel/Apple Silicon, and common Linux desktop distributions.
- [x] Add a CI matrix for Windows, Linux, standard Intel and Apple Silicon macOS runners across Node 22, 24, and 26; remote execution is still pending.
- [ ] Run the CI matrix on the repository host and review platform-specific results before release.
- [ ] Verify native trash/recycle behavior and path edge cases on all platforms.
  - Windows Recycle Bin move was smoke-tested with a temporary fixture; macOS Finder Trash and Linux desktop Trash remain pending.
- [x] Expose the installed version and add an explicit Settings check against GitHub's latest stable release; no request occurs until the user presses Check for updates, and no files are downloaded or installed.
- [x] Add a version-checked source archive command and a tag-triggered CI artifact workflow with explicit secret/database/build-cache exclusions.
- [ ] Add signed native installers where signing credentials are available.
- [x] Add privacy, threat-model, backup/restore, and troubleshooting documentation.
- [x] Bind the Next.js UI to `127.0.0.1` explicitly in the launcher and direct start scripts rather than relying on the development server default.
- [x] Add a short release smoke-test checklist; bounded synthetic fixtures are covered by temporary-database tests.
- [x] Resolve Windows drive metadata from the selected path's volume root; retain statfs metadata for UNC shares rather than treating them as malformed drive letters.
- [x] Apply a timeout to the Windows Recycle Bin command so a stalled shell operation does not leave cleanup pending indefinitely.
- [x] Require a supported Node.js 22+ system runtime and bootstrap a managed Node.js 24 LTS runtime; Node 20 is end-of-life.
- [x] Enforce the Node.js 22+ minimum in the launcher, server, and direct collector entrypoints, with a unit-tested version policy.
- [x] Restrict live WMI drive refresh to Windows; Linux and macOS serve stored metadata without attempting a Windows shell command.
- [x] Preserve Windows `statfs` capacity when optional CIM metadata is unavailable.
- [x] Fold root case only on Windows; preserve distinct POSIX roots on Linux and case-sensitive macOS volumes.

## Measurement definitions

- **Drive capacity:** reported by the operating system for a mounted volume.
- **Indexed bytes:** sum of file sizes in the DiskLens index for a selected root. It can be lower than drive-used bytes because excluded, inaccessible, unindexed, sparse, metadata, and filesystem-reserved content may differ.
- **Progress:** entries discovered during the collector's scan pass divided by the estimate pass count. It is an estimate when the filesystem changes during scanning.
