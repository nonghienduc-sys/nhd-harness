# NHD Harness Lite — Windows distribution and MCP onboarding

## Architecture / privacy
- `electron-builder.lite.cjs` contains an explicit application payload allowlist.
- The lite installer includes the NHD core, dashboard, scripts/workers, skills, Cloudflare binary and a pinned official Python embeddable runtime.
- It excludes runtime memory, databases, checkpoints, release-state, venvs, archived test artifacts and local credentials.
- The user's Cloudflare cert/credentials remain under their own Windows user profile; NHD never uploads them.
- The API setup wizard is restricted to localhost by `/api` host guard and never creates a DNS record unless the local user explicitly checks consent.
- After consent, NHD requests Cloudflare tunnel startup automatically; the supervisor re-reads saved configuration when starting, so an app restart is not required. Do not rename or overwrite a zone's existing DNS.
- Public OAuth MCP is `https://<subdomain>.<domain>/mcp`; no bearer tokens, API keys or private tunnel credentials should be shared in chat.

## Source and release commands
```powershell
npm ci
npm test
./scripts/prepare-lite-python.ps1
./scripts/prepare-lite-cloudflared.ps1
npm run package:lite:build
./scripts/prepare-lite-release.ps1
```
Output: `release-lite/NHD-Harness-Lite-Setup.exe`, with verified payload in `release-lite/win-unpacked/resources/app/`.

To publish, create a **separate, reviewed GitHub repository** and inspect source/history for credentials. The configured GitHub connector had no accessible repository at first audit; no public repository/release was created automatically. `.github/workflows/release-lite.yml` supports manual Windows builds, stores a verified build artifact, and creates a *draft* GitHub release only for a deliberate `lite-v*` tag.

## Onboarding new Windows computers
1. Run the Lite installer. On fresh installation the application loads `/setup.html` rather than the regular dashboard.
2. With an existing Cloudflare-managed domain, enter the zone and subdomain. Click login, select the zone, verify the cert is present, tick the DNS-change consent, and click provision. NHD runs `cloudflared tunnel create` then `route dns` with validated arguments. If DNS exists, fail closed; no overwrite.
3. NHD automatically requests tunnel startup. If unavailable, click **Bật lại tunnel**; then verify OAuth resource metadata over HTTPS. No app restart is normally needed.
4. In ChatGPT Web, go to Plugins → plus → Add custom MCP server. Enter the HTTPS `/mcp` URL, select OAuth, authorize, and test one safe read operation.
5. Alternatively select OpenAI Secure MCP Tunnel. Obtain Platform tunnel_id, scoped runtime key and workspace permissions; install official tunnel-client separately, run doctor, and select Tunnel under ChatGPT connection.
6. Confirm successful ChatGPT tool call, then mark the NHD first-run wizard complete.

## Minimal vs optional
- Lite is enough for MCP Core, Office/UI control and basic Background Turbo.
- OCR, semantic memory, document conversion and advanced PDF dependencies are optional. Their implementation remains available in the source, but their Python environments are intentionally absent until installed in a verified add-on.
- Do not claim 100% health on clean Lite installation until each enabled optional worker passes its test; disable or install optional modules before declaring Full ready.

## Acceptance gates
- `npm test` green; Lite package audit green; `--verify` excludes personal runtimes and includes workers.
- Installer has a SHA-256 checksum in release metadata. Before public release add code signing and verify Windows SmartScreen behavior.
- Smoke test on a clean Windows VM for Python worker, MCP HTTPS/OAuth, Cloudflare login/DNS, and custom plugin read-only call. No production restart or public DNS changes as part of CI.
- No public release or automatic production promotion without owner approval and a staged rollback receipt.

## Public distribution without exposing source

Create a **public assets-only** repository once, for example `OWNER/nhd-harness-downloads`, and grant a fine-grained GitHub token Contents:write only on that repository. In the private source repository configure GitHub Actions variable `NHD_DISTRIBUTION_REPO=OWNER/nhd-harness-downloads` and repository secret `NHD_DISTRIBUTION_TOKEN` (never put its value in code or chat). The release workflow publishes *draft assets* to this destination when a `lite-v*` tag is pushed. Review and publish that draft; subsequent versions follow the same pipeline. No private source needs to become public.

After the owner publishes a release, share the permanent URL `https://github.com/OWNER/nhd-harness-downloads/releases/latest/download/NHD-Harness-Lite-Setup.exe`. Replace OWNER only after the actual public repository exists. Draft releases do not count as published.

## Easiest route without uploading source code to GitHub

For a one-time setup, create a **public assets-only repository with a README** on GitHub. Install the official `GitHub CLI` on the source Windows PC (`winget install --id GitHub.cli -e`), run `gh auth login` as the owner, then set `$env:NHD_DISTRIBUTION_REPO = 'OWNER/nhd-harness-downloads'` and run `./scripts/publish-lite-github.ps1`. This script checks GitHub permissions and repository visibility, verifies the installer against SHA256SUMS plus release-readiness, then uploads **only the .exe and checksum** as a **draft release**; it never publishes source code and never silently overwrites existing assets. The owner reviews and publishes the draft. Subsequent new Lite versions run the same command with a new version tag. The GitHub Actions option remains available when the source is in an authorized private repository.

In either route, the owner must complete GitHub authentication, accept the draft release, and sign the installer if a public trusted distribution is required. Do not use GitHub without account authorization or upload private NHD runtime contents.
