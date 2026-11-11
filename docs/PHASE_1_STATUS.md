# Phase 1 implementation status

The scan/index reliability changes are implemented and covered by the current bounded suite. Native platform checks and the large-index read-only verification remain release tasks.

Implemented:

- Normalize/deduplicate requested roots and reject nested/overlapping roots (Windows comparisons are case-insensitive and boundary-aware).
- Reject symbolic-link roots; do not traverse directory symlinks.
- Prevent overlapping active scan jobs and preserve final outcomes for each root in a multi-root job.
- Keep scan data staged until success; cancellation, interruption, or failed roots do not replace the last good index.
- At commit, retain unchanged item row IDs, update changed entries in place, remove deleted accessible entries, and preserve old descendants below an inaccessible staged directory.
- Store path/metadata-only fingerprints for fully accessible completed snapshots and compare them with the prior comparable scan; restricted snapshots do not claim equality.
- On API shutdown, request collector cancellation, wait for exit, then clean unfinished staging before SQLite closes.
- Report estimation/live progress, uploaded/skipped counts, per-location status, elapsed time, and ETA when measurable.
- Exclude common credential directories, environment files, and private-key artifacts.

Verification: the latest full bounded run passed all 67 tests with 0 failures or skips. Windows directory-link checks use temporary junctions, and the live localhost scan smoke test uses two temporary roots and an isolated database. The existing 777,471-item workspace index was previously opened read-only and passed SQLite quick_check; its real schema was left unchanged. See the root `TEST_REPORT.md` for current evidence and remaining checks.

Do not use a full-drive scan as a test. Verify the existing large index read-only before release.
