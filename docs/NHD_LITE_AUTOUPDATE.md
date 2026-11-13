# NHD Harness Lite — Auto-Update v0.24.8 (source candidate)

## Distribution
- Source: D:\ChatGPT-Workstation-MCP. Current production remains the immutable 0.24.7 release; this 0.24.8 change is staged only.
- The packaged Windows Electron app checks public GitHub Releases in nonghienduc-sys/nhd-harness-downloads after startup and every 12 hours, without a token.
- Only published, non-prerelease tags matching lite-vMAJOR.MINOR.PATCH are accepted. The asset name must be NHD-Harness-Lite-Setup.exe. Version must increase.
- A notification can appear for a newer release. No automatic installer download or execution occurs without user approval. The Settings button and tray menu both allow manual check.

## Transaction and integrity
1. GitHub API asset digest must specify SHA-256, a bounded expected size and an exact tagged URL in the trusted GitHub repository.
2. The download follows HTTPS redirects only to known GitHub-owned asset hosts; streamed bytes must match exact size and SHA-256. Partial or changed payloads are rejected.
3. The updater requires a matching, SHA-256-verified installer for the currently installed version as a rollback candidate, as well as the future installer.
4. Config snapshots include only bridge-data/config.json, bridge-data/setup-complete.json and bridge-data/cloudflare/config.yml; no projects or databases are copied or uploaded. Backups and file hashes are retained under userData/nhd-updates.
5. After user consent, a detached PowerShell guardian (copied to per-user updater cache) waits for NHD to exit, runs the Windows NSIS installer, launches NHD and waits for a version-bound health marker.
6. If install or health fails, the guardian attempts to reinstall the verified old installer, restore the config snapshot and confirm old backend health. It writes a guardian-receipt.json with success, rolled-back, rollback-unverified, rollback-failed or installer-timeout.
7. The guardian refuses concurrent rollback when a new installer is still running. Unresolved transactions and backups are kept rather than silently deleted.

## Important limitations
- The current public installer is not Authenticode-signed. SHA-256 verifies integrity against GitHub's asset digest, but does not establish publisher identity if the repository itself is compromised. Signing and release-protection settings are still recommended.
- Windows installer execution and recovery is best-effort, not a filesystem-atomic rollback. A power failure, OS restart, antivirus block or corrupted installer could prevent automatic recovery.
- Snapshot contains selected configuration files, not every application database, document or runtime. Those should remain outside the app installation directory and are not overwritten by the installer.
- The new updater uses the GitHub Release API directly and does not require electron-updater or latest.yml. User must explicitly approve download and then installation.
- Mocked test receipts do not prove a real clean Windows install/rollback. Do not broadly publish v0.24.8 before clean Windows GUI verification and a real recovery rehearsal.

## Build and release sequence
1. npm test; npm run docs:architecture:check.
2. npm run package:lite:build. This creates a versioned 0.24.8 candidate separately; do not overwrite v0.24.7's public assets.
3. Run packaged backend and UI smoke tests, check version and installer SHA-256.
4. Test real install/upgrade/rollback on clean Windows. Sign release when feasible.
5. Upload and review GitHub DRAFT lite-v0.24.8 with installer and SHA256SUMS; publish only after explicit owner approval.

## Implementation files
- electron/lite-update-core.cjs — semver, URL allowlist, GitHub API SHA-256 and stream validation, configuration backup.
- electron/lite-updater.cjs — periodic check, two-step consent handoff, download staging, health marker.
- electron/lite-update-guardian.ps1 — independent installer, recovery and receipt.
- electron/lite-update-preload.cjs — trusted renderer IPC only.
- electron/main.cjs, dashboard/index.html, dashboard/lite-updates.js — tray and Settings update UI.
- test/lite-updater.test.mjs — fail-closed tests.

Public old installer remains accessible at https://github.com/nonghienduc-sys/nhd-harness-downloads/releases/tag/lite-v0.24.7.
