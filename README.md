# ChatGPT Workstation MCP Bridge

Windows MCP bridge for controlled access from ChatGPT Web to local files, PowerShell, Microsoft Office, the interactive desktop, approved document inboxes, and PDF intake workflows.

## Run locally

```powershell
Set-Location D:\ChatGPT-Workstation-MCP
npm install
npm run build
npm test
npm start
```

Dashboard: `http://127.0.0.1:39100/`

The MCP endpoint is `http://127.0.0.1:39100/mcp` locally. The configured production-style endpoint is `https://mcp.nhdmcp.io.vn/mcp` through the named Cloudflare Tunnel `chatgpt-workstation-mcp`. Start or stop it from the local dashboard. The pairing code is shown only on the local dashboard.

## Capabilities

> Since v0.24.15 related tools are merged into `op`-based facades; old names remain deprecated aliases until at least v0.24.18. See [docs/TOOL_FACADES_MIGRATION.md](docs/TOOL_FACADES_MIGRATION.md).

- File listing, metadata, bounded reads, SQLite FTS indexing/search, and preview/apply write, move and delete under `D:\`.
- PowerShell preview/execute with risk classification, one-time five-minute confirmation tokens, timeout, output limit and process-tree cancellation.
- Offline DOCX/XLSX/PPTX reading and controlled edits.
- Project-scoped `.nhd` memory with decision states, source snapshots, document maps, dependency graphs, durable edit sessions, strictly bounded context packs and semantic DOCX paragraph/clause/article/chapter edits.
- Office Companion for Word, Excel and PowerPoint PDF export plus read-only Outlook inbox search and message reading.
- Screen Companion for listing displays and visible application windows, then returning an owner-enabled automatic or manually confirmed PNG capture to ChatGPT for visual analysis.
- Windows UI Automation navigation plus an owner-controlled visual fallback for applications that hide their accessibility tree.
- Read-only document intake from approved inbox folders such as Downloads and Zalo Received Files; the rest of the user profile remains outside scope.
- Bounded PDF inspection, reading, search, page rendering and optional OCR for selected scanned pages.
- OAuth/PKCE, token revocation, audit log, emergency stop and local dashboard.
- Dashboard Tools page backed by the live MCP registry: shows every registered tool, group, permission, destructive flag, and whether the current owner settings make it enabled, disabled, or partially available.
- Packaged Skill Registry with versioned office workflows, instruction hashes, supporting scripts/assets, search, activation, validation, resource reading, and per-skill enable/disable controls.

## Office Skill Registry

ChatGPT can discover office workflows with `skills_list` or `skills_search`, inspect them with `skills_get`, activate one for a task with `skills_activate`, and read packaged text references with `skills_read_resource`. `skills_validate` checks all packaged skills and their resources. Skill instructions are guidance only: they cannot bypass filesystem, Office, terminal, OAuth, or confirmation controls.

Outlook sending, draft creation, deleting or moving mail, calendar mutation, automatic VBA, and direct arbitrary dashboard command execution are unavailable.

## Screen access

ChatGPT can call `screen_list` to see available displays and visible window titles, then call `screen_capture` directly. When Screen Access is enabled on the dashboard, no per-image confirmation is required, allowing ChatGPT to capture again as needed during one task. Every capture is rate-limited and audited. The older `screen_preview_capture` and `screen_apply_capture` flow remains available for manually confirmed captures. Screen access can be disabled independently and is also disabled by Emergency Stop.

The Screen Companion runs only in the signed-in interactive Windows session. Minimized windows, protected video, secure desktop prompts, lock screens, and some hardware-accelerated surfaces may return an empty or black capture. Close or hide passwords, tokens, private email, and unrelated sensitive content before approving a capture.

## Desktop and document intake

Use `desktop_windows`, `desktop_inspect`, and `desktop_action` for verified read-only navigation. UI Automation is preferred. When an application such as a browser sidebar exposes no controls, the owner may enable visual fallback and ChatGPT can use `screen_capture` followed by normalized `click_point` actions. Each coordinate click is hit-tested against the selected window, returns detected-control metadata, and must be checked with a new screen capture after the action.

`intake_files` reads only dashboard-approved inbox roots. `pdf_document` handles PDF inspect/read/search/render/OCR. `desktop_document_intake` combines these layers for workflows such as finding the latest PDF in a named Zalo conversation. See `docs/INTERACTIVE_DOCUMENT_INTAKE.md`.

## Current v1 boundaries

- PowerShell commands are confirmed and executed as isolated runs. Long-lived stateful PowerShell sessions are not enabled yet.
- Legacy offline Office editing supports DOCX/PPTX text replacement and XLSX cell updates. For long DOCX work, use the v0.3 `document_*` tools: they map logical sections and preserve separate heading/body formatting during semantic edits. A DOCX currently open in Word is rejected by the offline semantic editor to prevent unsaved-change conflicts; live COM editing remains a separate follow-up.
- The Windows service installation and ChatGPT Web connection require user-side Administrator and account UI steps described below; they cannot be completed silently by the local development process.

## Installation

Run an elevated PowerShell window only after reviewing the scripts:

```powershell
Set-Location D:\ChatGPT-Workstation-MCP
npm install
npm run build
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-service-user.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-companion-startup.ps1
```

The Windows service wrapper is installed through `node-windows`. Configure its Log On account in `services.msc` when unattended access must use a particular Windows account. The Office Companion runs after the interactive user logs on.

The service uses the Electron-provided Node runtime stored under this project, so it does not depend on a separate system Node installation after setup. Keep the project directory and `node_modules` in place while the service is installed.

## Security

- The default root is `D:\`; traversal, symlinks/junctions, secret-like names and high-risk folders are blocked.
- Every write and PowerShell command requires preview followed by an unexpired, one-time token.
- Automatic screen capture is allowed only while the owner-controlled Screen Access switch is enabled; every capture is audited and the image is not written to disk by default.
- Desktop navigation, visual fallback, document intake and OCR have independent owner switches. Emergency Stop disables all of them.
- Accessible or hit-tested controls for sending, deleting, uploading/attaching new files, credentials, payments, transfers and calls are blocked by the interactive companion. Opening or downloading an already received document is allowed. Enter is not exposed as a keyboard action.
- OAuth access and refresh tokens are stored only as hashes. The pairing code is memory-only, rotates on service restart, and is shown only by the local dashboard.
- Dashboard and `/api/*` are localhost-only. Named Tunnel ingress exposes only `/mcp`, `/oauth/*` and OAuth discovery endpoints; every other public path returns `404`.
- Emergency Stop disables writes and terminal execution and stops the tunnel.
- Runtime data defaults to `C:\ProgramData\ChatGPTWorkstationBridge`; development falls back to `.workstation-mcp` if that directory is not writable.

## Project context workflow

1. Use `project_open` with `preview_init`, then `apply_init`, to create `<project>.nhd`.
2. Call `document_index` for the primary DOCX.
3. Use `document_context` for one article or clause instead of reading the complete document.
4. Start an edit session, then use `document_edit_preview` and `document_edit_apply` for a hash-bound semantic change.
5. Run `document_qa`; inspect `project_status` before continuing in a later chat.

See `docs/PROJECT_MEMORY.md`, `docs/CONTEXT_ORCHESTRATOR.md`, `docs/DOCUMENT_EDITING.md`, `docs/INTERACTIVE_DOCUMENT_INTAKE.md`, and `docs/SECURITY.md` for the complete current behavior.

For architecture maintenance, `docs/generated/ARCHITECTURE.md`, `docs/generated/CAPABILITIES.md`, and `docs/generated/capability-catalog.json` are generated from the current MCP registries and Capability Registry. Run `npm run test:architecture` to detect architectural or documentation drift.
