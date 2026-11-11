# Release smoke test

Use a disposable test account and a temporary folder with a few small files. Do not scan an entire drive for release checks. Record OS version, CPU architecture, Node version, installer commit, and results.

## Automated checks

From `server`, run `npm test` (the suite uses temporary SQLite databases and mocked provider responses). From `frontend`, run `npm run build`. Review `git diff --check` and confirm no `.env`, database, API key, user data, or generated dependency/build folders are part of the release artifact.

## Native OS checks

Run on Windows 10/11, macOS Intel and Apple Silicon, and a current Linux desktop distribution:

1. Install for the current user; verify it does not request administrator/root access.
2. Launch with a supported system Node version and with no system Node (runtime bootstrap path). Confirm the app opens at a loopback URL and a second launch is rejected cleanly.
3. Scan a disposable folder. Confirm estimate/progress/ETA, completion, visible files, and drive metadata where available.
4. Scan two independent folders, then try overlapping roots. Confirm sequential per-root status and a useful overlap error.
5. Cancel during estimation and during upload. Confirm cancellation completes and the last good index stays visible. Restart the backend during a scan and confirm staging data does not replace the previous index.
6. Create a folder that the current user cannot read where the OS supports it. Confirm it is reported partial and previously indexed descendants are retained.
7. Verify path behavior for spaces, non-ASCII names, root paths, removable volumes, and case differences where the filesystem is case-insensitive.
8. In a disposable test tree only, verify duplicate grouping and explicit hash comparison. Confirm no hashing occurs before the user action.
9. Verify Trash/Recycle Bin behavior, then separately verify the permanent-delete warning without deleting valuable data. On Linux, check both available `gio` and `trash-put` paths or confirm a clear missing-utility error.
10. Configure a test AI key only if authorized. Confirm Settings never returns it, Test Connection performs a model-list check, and hosted calls happen only after an explicit analysis action. Remove the key and confirm the UI reports it unset.
11. Close and relaunch. Confirm the index persists. Back up and restore the per-user data directory using `docs/PRIVACY_AND_RECOVERY.md`.

## Current validation status

Automated synthetic fixtures and the frontend production build are covered by the project test report. Windows DPAPI, Restart Manager, and a native Recycle Bin move were exercised with temporary files. The automation used to restore the Recycle Bin fixture timed out; the file was recovered from its matching recycle data and content-verified, but the Windows restore UI path was not verified. macOS Keychain/Finder Trash, Linux Secret Service/desktop Trash, native installers, and folder-picker checks still need their target systems. The Settings release check is manual and does not download or install; signed native packages require release infrastructure and signing credentials.
