# DiskLens change and test report

## Implemented in this source update

- Removed bundled runtime dependencies, Git metadata, and local secret files from the release archive.
- Added root and server `.env.example` templates; ignored `server/.env`.
- Added OpenAI Responses API and Anthropic Messages API provider support while retaining legacy Azure OpenAI support.
- Added deterministic offline rule-based results for file safety, top storage, and single-target storage advice.
- Added a provider status endpoint that reports provider/mode/model without exposing keys.
- Added provider request timeouts and automatic local fallback on provider errors.
- Added platform-aware filesystem capacity metadata using PowerShell on Windows and `fs.statfs` on Linux/macOS.
- Added collector progress counts, skipped-item counts, throughput, and graceful Ctrl+C batch flushing.
- Added a localhost source launcher with dependency bootstrap, available-port selection, health checks, and browser launch.
- Added Windows PowerShell, Linux shell, and macOS shell launcher wrappers.

## Checks

The archive was inspected and source changes were applied. - `node --check` passed for all 26 `.mjs` files.
- Offline AI fallback smoke tests passed for file safety, top-storage, and single-target analysis with all hosted-provider keys removed from the test environment.
- Collector smoke test passed on the current Linux environment: filesystem capacity metadata, recursive enumeration, and batch upload to a local mock HTTP server.
- No live hosted-provider call was made because no API credentials were used for testing.
- Frontend production build and full Fastify integration tests were not run because this environment did not install project dependencies after excluding `node_modules` from the release ZIP.

## Not certified / still requires native testing

- Windows 10/11, Linux distribution, and macOS Intel/Apple Silicon installer builds.
- MSI/EXE, AppImage/DEB/RPM, and signed DMG packaging.
- Full parity for program discovery, Recycle Bin, Windows signature metadata, and file/folder open operations outside Windows.
- Real OpenAI/Anthropic/Azure calls: no live credentials were supplied for testing.
- Full destructive-operation safety testing against real user disks was intentionally not performed.
- Large-volume performance benchmarks and millions-of-files stress tests.
