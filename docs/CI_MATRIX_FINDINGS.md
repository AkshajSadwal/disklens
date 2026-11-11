# CI matrix findings and follow-up patch

Repository: `AkshajSadwal/disklens`
Commit reviewed: `876f5a3bbae1a402fbafd86bc7e31f9fd02830dd`
Workflow run: [DiskLens CI run 1](https://github.com/AkshajSadwal/disklens/actions/runs/43057746131)

## Initial matrix result

The first hosted run completed the frontend production build successfully. Test jobs passed on Windows Node 22/24, Ubuntu Node 22/24/26, and macOS Intel Node 24/26. Several other jobs exposed two underlying issues:

1. Windows Node 26 and macOS Intel Node 22 could receive a transient `overlaps an already active scan location` response when the integration test started a repeat scan immediately after a multi-root job. The per-root status is committed just before the collector parent process exits. The test now retries only this expected short-lived 409 response, with a bounded five-second timeout.
2. macOS Arm Node 22/24/26 exposed non-deterministic selection of the previous completed scan fingerprint when adjacent scans shared timestamps. The previous-run query now uses SQLite row insertion order (`rowid DESC`) as the stable tie-breaker. History and status selection use `started_at DESC, rowid DESC` as well. A regression test sets equal completion timestamps and scan IDs in the opposite lexical order to verify that the latest inserted partial scan invalidates the earlier full-snapshot fingerprint shortcut.

## Added resource coverage

- A directory-stack unit test queues and drains 5,000 paths while asserting the in-memory frontier never exceeds 64 entries.
- The live localhost API integration fixture now creates 1,100 sibling directories with one file each, forcing both estimation and traversal past the default 1,024-entry memory frontier. It asserts all 2,200 directory/file rows and all 1,100 bytes are indexed.

## Local verification in this patch

- 27 collector/path/queue/safety tests passed on Linux Node 22.16.0, including the 5,000-entry frontier test.
- Changed `.mjs` files passed `node --check`.
- The full database-backed suite and the new live API wide-tree integration could not be rerun in this container because `npm ci` timed out while fetching dependencies; partially downloaded `node_modules` was excluded from the archive.

## Required after applying the patch

Push the patch to the repository and confirm a new GitHub Actions run is green across the full existing matrix. Do not mark native release validation complete until that rerun passes.

## Still environment/credential dependent

- Manual Windows 11 cancellation/restart verification with an active user scan.
- Native macOS and Linux desktop Trash/folder-picker smoke tests beyond the automated hosted runner suite.
- Signed native installer generation; no Windows code-signing certificate or Apple Developer ID/notarization credentials were provided.
- True filesystem-journal incremental refresh remains deliberately deferred. Current repeat scans still enumerate all entries and read metadata; a safe cross-platform journal requires loss detection and a full-scan fallback after offline periods or watcher overflow.
