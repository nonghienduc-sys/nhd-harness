## Unreleased

### 0.24.51 - 2026-11-26

- Share private memory write previews across MCP server instances while retaining task, expiry, one-time apply, and destination checks.

### 0.24.50 - 2026-11-25

- Require fresh, real Harness page and visual checks for each Word artifact in completed receipts when the owner-configured page gate is active.
- Reject missing or stale checks before writing receipts or the time ledger; leave Lite and blocked receipts unchanged.

### 0.24.38 Word Live parallel acceptance hardening - 2026-11-17

- Moved Documents.Open outside the COM activation mutex; bounded mutex acquisition and handling of abandoned owners.
- Worker emits PID and StartTime immediately after creating a new WINWORD instance, before any slow Word properties or document opening.
- Pool durably registers early ownership, cancels late queued operations, bounds startup/requests/close, and verifies PID plus creation time before targeted process cleanup.
- Word Save alone is serialized across independent instances to avoid Office temporary-file contention; document edits still run in parallel.
- Added real regression for worker termination while holding the mutex and a 145-second independent watchdog with after/finally cleanup.
- Real test distinguishes concurrent user-visible Word windows from the specific test-owned processes.
- Production root and releases were not modified; no cutover or push.
### 0.24.38 - 2026-11-17

- Isolated path-scoped Word Live sessions: separate harness-owned WINWORD and PowerShell worker for each DOCX; up to four simultaneous sessions, per-path ordering, explicit close, idle and timeout cleanup.
- Added persistent PID/start-time registry, safe orphan reaping, FileShare.None lock checks and explicit stale owner-file handling without touching the user's Word windows.
- Added optional Word path/read_only/remove_stale_lock tool parameters, office_live_close/office_live_sessions, transaction routing and backward-compatible no-path behavior.
- Added unit tests, real four-file parallel COM regression tests, and Vietnamese operational documentation.


# Changelog

## 0.22.0 - 2026-10-10

- Replaced per-command isolated desktop PowerShell spawning with a persistent PowerShell UI Automation worker over bounded NDJSON stdin/stdout.
- Added persistent UIA window/selector caches, worker health telemetry, prewarm lifecycle, fail-closed timeout/disconnect semantics, and no replay after ambiguous delivery.
- Preserved Windows Sandbox isolation, host-foreground blocking, task-scoped risk authorization, sensitive-field blocking, and browser CDP behavior.
- Upgraded isolated guest Agent to 0.3.0.


## 0.21.0 - 2026-10-10

- Replaced the Windows Sandbox Isolated Agent realtime mapped-folder polling bus with a persistent Microsoft WinApp CLI stdin/stdout NDJSON transport. Mapped folders remain only for bootstrap heartbeat and artifacts.
- Added direct transport ready/heartbeat/response protocol, bounded stderr/status telemetry, startup and RTT metrics, and fail-closed pending-command rejection. Ambiguous/time-out commands are never replayed automatically.
- Upgraded guest Agent to 0.2.0 with `--bootstrap`, `--stdio`, and legacy `--file-bus` modes.
- Moved the isolated browser lane to dedicated headless Edge CDP port 9224 / profile-v2 so DOM and screenshots do not depend on the Sandbox interactive display.
- Normalized non-finite UI Automation bounds to null so desktop results remain valid JSON.
- Candidate benchmark on this workstation: ping avg 0.77 ms (p95 1.10), browser status 5.57 ms, snapshot 7.42 ms, inspect 5.70 ms, screenshot 43.84 ms, versus ~15–16 seconds command-bus tail latency in v0.20.0.
- Preserved Dual Execution Lanes isolation, task/risk authorization, sensitive-field blocking, no host-GUI fallback, and non-replay semantics.
## 0.20.0 - 2026-10-10

- Added dual execution architecture: Background host-session lane plus Windows Sandbox Isolated Agent lane, designed to run concurrently without sharing foreground input.
- Background now has a hard no-foreground policy: host desktop mutations are blocked, dedicated automation browser runs headless, Cốc Cốc cannot switch foreground tabs for Background work, and visual GUI escalation routes to Isolated Agent.
- Added deterministic per-step execution routing, lane scheduler/reservations (2 Background + 1 Isolated by default), TTL resource locks and task-scoped artifact handoffs under `D:\NHD-Agent-Exchange`.
- Added Windows Sandbox host service and guest companion with isolated Edge/CDP browser, deep DOM snapshot/inspect, task-scoped click/press, safe fill, browser screenshot, guest UI Automation, guest-only mouse/keyboard and desktop screenshot.
- Added isolated/execution MCP tools and local dashboard APIs. Isolation never weakens NHD risk policy: sensitive fields remain blocked, commit/sensitive actions require task authorization, command timeouts are never replayed automatically, and offline Isolated Agent never falls back to host GUI.
- Added Windows Sandbox setup script and dual-lane architecture documentation.

## 0.19.0 - 2026-10-10

- Upgraded the Cốc Cốc extension bridge to v0.4.0 comprehensive task-scoped browser control over the user's existing logged-in tabs.
- Added bounded deep page snapshots with visible text, headings, links, scroll/page state, open shadow roots and same-origin frame content.
- Added DOM scroll/focus/hover/select/approved-key actions plus machine-checkable wait conditions and exactly-once verified click/fill flows.
- Added extension-backed tab listing/open/activate and task-authorized navigate/reload/back/forward/close operations.
- Added viewport screenshots and combined DOM+visual observation for logged-in Cốc Cốc pages.
- Preserved mandatory safety boundaries: no arbitrary JavaScript execution, credential/file/payment-sensitive fields remain blocked, ordinary commits remain task-scoped, and high-risk actions still require matching high-risk authorization/objective scope.
- Extended browser-form Governor routing toward verified Cốc Cốc actions and kept live browser state uncached.

## 0.18.3 - 2026-10-09

- Added a backward-compatible Word Compatibility Fast Lane for ChatGPT conversations whose MCP connector schema was mounted before `office_live_append` / `office_live_insert_at_cursor` existed.
- Reuses the already-mounted `office_live_preview_edit` + `office_live_apply_edit` pair with an exact `NHD_WORD_DIRECT_V1:` base64url envelope; no `.mjs`, filesystem or Terminal hop is needed for routine rich Word append/insert in stale-schema chats.
- Compatibility payloads decode into the existing V2 `word_append` / `word_insert_at_cursor` operations and therefore retain fingerprinted preview/apply-once, exact text verification, per-block rich-format verification and visual QA.
- Ordinary `replace_selection` behavior is unchanged; malformed compatibility payloads fail closed before any Office call.
- No general capability was removed or hidden: filesystem, Terminal, Browser, PDF/OCR, Video, Cốc Cốc, Excel/PowerPoint and MCP-development paths retain their existing tool surface.
- Tool Governor reports the stale-schema compatibility route while continuing to prefer first-class Direct Word tools whenever the client exposes them.
- Added three regression tests for cached-schema rich append, unchanged legacy selection replacement, and malformed-envelope fail-closed behavior. Candidate full regression: 263/263 PASS before version finalization.
- Local `/api/health` now exposes the same immutable Governor Word Direct policy used by MCP `workstation_health`, so rollback-safe cutover verification cannot falsely fail because the local health surface omitted Governor state.
- Architecture note: `docs/WORD_COMPAT_FAST_LANE_v0.18.3.md`.

## 0.18.2 - 2026-10-09

- Enforced Word Live Direct Fast Lane for routine Word mutations that Office Live can express. Terminal preview now fails closed with `DIRECT_WORD_ROUTE_REQUIRED` before spawning PowerShell/COM for routine append/insert/text/font/paragraph work.
- Added `fontColorHex: #RRGGBB` to Word Live formatting and per-block verification, covering the TOEIC red/green/teal/dark-blue study format without PowerShell fallback.
- Blocked `Invoke-Expression` and alias `IEX` in Terminal commands and referenced `.ps1` content. Dynamic evaluation is no longer an allowed fallback path.
- Added hybrid UTF-8-safe PowerShell launch: ordinary ASCII commands retain low-latency `-Command`, while Unicode commands and standalone `.ps1` fallback use `-EncodedCommand`. Standalone scripts are read as UTF-8 by Node before PowerShell sees them.
- Added UTF-8 preamble for PowerShell stdin/stdout and default `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` in the safe Terminal environment.
- Standalone `.ps1` fallback must be argument-free; nested `powershell -File` and argument-bearing script invocation are blocked so Windows PowerShell 5.1 cannot reinterpret script-file encoding or introduce another quoting layer.
- Unsupported Word COM fallback remains available but its Terminal timeout is clamped to 30 seconds, preventing multi-minute stalls.
- Tool Governor status now reports the Word Direct hard-guard policy and Word/TOEIC profiles explicitly avoid all Terminal preview/session execution tools unless fallback is genuinely required.
- Added regression coverage for dynamic-evaluation blocking, Word Direct redirect, 30-second fallback clamp, UTF-8 no-BOM Vietnamese `.ps1`, generic Unicode PowerShell, and argument-bearing script rejection.
- Deterministic 5,000-iteration benchmark: Governor plan mean 0.077638 ms, Word Direct guard mean 0.525916 ms, Invoke-Expression guard mean 0.050057 ms.
- Architecture note: `docs/WORD_DIRECT_EXECUTION_POLICY_v0.18.2.md`.

## 0.18.1 - 2026-10-09

- Added first-class Word Live Direct Fast Lane tools: `office_live_append` and `office_live_insert_at_cursor`. Simple append/insert tasks no longer need Terminal/PowerShell/COM orchestration.
- Both direct tools keep the existing safety/quality contract internally: live target fingerprint, one-time preview/apply transaction, exact text verification, per-block formatting verification, bounded cursor placement, working-state update and mandatory visible Word QA capture.
- Added rich insertion blocks with optional Word formatting per block, enabling a single call to append headings/questions/body text with different bold/font/paragraph properties.
- Added `word_append` and `word_insert_at_cursor` to the generic Office Live V2 operation layer while preserving existing selection replacement and formatting operations as fallbacks.
- Updated Tool Governor so current-version task policy/recommended Direct Fast Lane tools outrank stale historical task recipes. Historical recipes remain advisory fallback evidence.
- TOEIC/Word profiles now prefer direct Word insertion primitives before generic preview/apply or Terminal fallback.
- Added direct-insert validation for 1-200 blocks, 20,000 total characters, collapsed cursor safety and optional bounded cursor offset.
- Expanded registry tests for the two new tools. Final regression passes 253/253 after visual-QA hardening.
- Hardened Office visual QA to fail closed when the active Office document identity does not match the visible window title, preventing a screenshot from another open Word/Excel/PowerPoint document from being treated as evidence.

## 0.18.0 - 2026-10-09

- Added `tool_governor`, a deterministic middle layer between ChatGPT Web tool requests and MCP handlers. It preserves full MCP capability awareness and Direct Fast Lane behavior instead of hiding tools or inserting a second LLM.
- Added project/task-aware planning with bounded Memory Resolver context from global preferences, project preferences, structured facts, confirmed decisions, similar durable tasks and learned task recipes. Broad chat-history dumps are deliberately excluded from routine planning.
- Added persistent preference history with current-value supersession and credential/secret rejection. Preferences may be global or project-scoped.
- Added learned Task Recipe memory keyed by project + task class. Successful checkpoint/completed-task flows record the actual compact tool workflow, call count and duration for later reuse as advisory guidance only.
- Added quality floors, soft tool budgets and progressive-escalation triggers for TOEIC grading, Word Live edits, financial-document work, OCR, research, browser forms, video/storyboard tasks, MCP development, MCP health and file management.
- Added exact duplicate-call telemetry and a conservative short-lived cache only for low-volatility meta reads such as skill discovery/validation and local AI status. Live Office, Browser, Cốc Cốc, filesystem, health and context reads remain uncached.
- Replaced ritual skill discovery guidance: obvious one-tool work stays direct; nontrivial/uncertain workflows call Governor once, and skill discovery is used only when it adds new capability/workflow evidence.
- Added Governor telemetry to workstation health and automatic cleanup of stale advisory plans/cache entries without affecting durable task state.
- Local deterministic benchmark: planning averaged 0.112313 ms for TOEIC, 0.096998 ms for CMC financial-fill and 0.080626 ms for MCP development; capability-map generation averaged 0.005674 ms. Benchmark excludes Office/browser/network/LLM latency.
- Added dedicated Governor tests and updated registry expectations; candidate regression passes 250/250.
- Unified OCR dispatcher remains production-ready: PaddleOCR primary, Tesseract fallback, explicit engine selection and normalized confidence metadata.


## 0.17.0 - 2026-10-09

- Preserved the original ChatGPT Web -> MCP -> Skill/Tool path as the Direct Fast Lane; Local AI is not inserted into every request.
- Added `local_ai_dispatch` to choose among `direct_tool`, `context_gate`, `local_text_worker`, and `cloud` without executing actions.
- Added `local_ai_text_worker`, a bounded advisory Qwen2.5-1.5B Q4_K_M worker for schema extraction, summarization, and rewrite only. It is loopback-only, cannot call tools, and cannot authorize workstation actions.
- Added on-demand llama.cpp startup with CPU-only settings and owned-process idle shutdown. Existing externally started loopback workers are reused but never killed by NHD.
- Local text-worker outputs are explicitly advisory; schema verification checks shape only, never factual correctness.
- NHD Task Runtime and Risk Policy remain the sole task-state and authorization authorities; ambiguous actions remain non-replayable.
- Current/deep/high-stakes tasks stay in the cloud lane; deterministic/search/tool workflows keep the direct path.

## 0.16.1 - 2026-10-09

- Benchmarked Local Intelligence routing on this workstation. A character-trigram Naive Bayes router substantially outperformed the v0.16.0 deterministic-only baseline on both synthetic bilingual and user-style holdouts while remaining sub-millisecond.
- Added a built-in tiny advisory router (`src/tiny-router.ts`) as a fallback only; it never executes tools, grants authorization, or overrides safety/currentness/context gates.
- Added a task/memory context gate for deictic commands such as `lÃ m Ä‘i`, `tiáº¿p tá»¥c`, and `xÃ¡c nháº­n...` so they are resolved from durable context rather than guessed from text alone.
- Reordered multi-step detection ahead of retrieval and expanded deterministic status/open/currentness detection.
- Installed and benchmarked llama.cpp + Qwen2.5-0.5B-Instruct Q4_K_M locally for research only. The 0.5B LLM is not enabled in production routing because cold-start latency and routing reliability were worse than the tiny classifier.
- Model invocation remains disabled; NHD Task Runtime/Risk Policy remain authoritative.

## 0.16.0 - 2026-10-09

- Added the NHD Local Intelligence Layer foundation: a lightweight Hermes-inspired advisory layer that reuses NHD Task Runtime, Risk Policy, Memory and existing tool execution instead of duplicating a second agent state machine.
- Added `local_ai_status`, `local_ai_route`, `local_ai_verify`, and `local_ai_probe`. All four are read-only/advisory in v0.16.0 and cannot execute workstation actions or grant authorization.
- Added tiered fast-path routing across deterministic rules, semantic retrieval, tiny/small local-model candidates, optional local reasoning, and ChatGPT cloud escalation.
- Added a verifier gate that never replays ambiguous actions and explicitly defers side-effect authorization to the existing NHD policy system.
- Added loopback-only provider discovery/probing for Ollama, LM Studio/OpenAI-compatible endpoints and llama.cpp, plus Hermes Agent installation detection. External model endpoints are blocked by default in this foundation.
- Exposed Local Intelligence status in both `workstation_health` and local `/api/health`. Model invocation remains deliberately disabled until local latency/accuracy benchmarks justify enabling it.

## 0.15.0 - 2026-10-09

- Added incremental project file indexing with a debounced local watcher, single-path refresh/removal, watcher health telemetry, and automatic watch startup for the configured project workspace.
- Added `fs_index_watch` for watcher status/start/stop/refresh without weakening filesystem write protections.
- Exposed the same incremental watcher telemetry through local `/api/health`, keeping dashboard/deployment health checks consistent with `workstation_health`.
- Added a read-only MCP Tasks 2026 compatibility projection mapping durable NHD task state to `working`, `input_required`, `completed`, `failed`, and `cancelled`, including elicitation-shaped input requests for paused/confirmation states.
- Added `task_agent_cycle`, a deterministic step/verify/input/terminal coordinator that never executes tools or treats task metadata as authorization.
- Preserved existing preview/apply transactions, risk-based task authorization, no automatic replay after ambiguous actions, Emergency Stop, and current legacy MCP transport compatibility.
- Deliberately deferred the SDK v2 / 2026-07-28 transport cutover to a separate migration because the stable v2 SDK uses a split package/API surface and a modern handshake; v0.15.0 provides the backward-compatible runtime foundation first.

## 0.14.0 - 2026-09-29

- Added Video Intelligence with five MCP tools: `video_inspect`, `video_understand`, `video_search`, `video_frame`, and `video_context`.
- Added subtitle-first understanding for local and online video, including embedded subtitle extraction and yt-dlp remote/automatic caption retrieval before any speech recognition work.
- Added local `faster-whisper` ASR fallback with speed-oriented defaults: tiny (FAST), base (SMART), small (DEEP), using CPU int8 when CUDA is unavailable.
- Added sparse visual understanding: low-resolution URL visual caching, keyframe/scene sampling, exact on-demand frames, and multimodal MCP image returns without reading every frame.
- Added reusable source-fingerprint cache and timestamped semantic timelines so later questions can search or inspect only relevant time ranges.
- Added the `video-understanding` media skill and integrated Video readiness into workstation health/tool inventory.
- Added dedicated Video unit tests and an end-to-end synthetic video validation covering metadata, embedded subtitles, keyframes, timeline search, exact frame extraction, and ranged context.

## 0.13.0 - 2026-09-28

- Added project-per-task orchestration: a rootless new durable task automatically creates a persistent physical project folder under the configured project workspace root (default `D:\\NHD Projects`) and initializes its existing `.nhd` project state.
- Added durable task-to-project marker files and project references so task identity survives ChatGPT tab changes.
- Added explicit external artifact bindings: file/document references and working-state paths resolve back to the same project even when the file lives outside the project folder.
- Added automatic project-memory hooks for filesystem writes/moves and offline Office edits, complementing existing Office Live working-state hooks.
- Added a multi-project local API and dashboard project list showing project folders and their active/latest durable tasks.
- Preserved backward compatibility for existing manually initialized projects and explicit task roots.


## 0.12.0 - 2026-09-28

- Added a structured `resumeState` to context bootstrap so new chats can resume deterministically from the active durable step/task, semantic checkpoint, or idle project state.
- Active durable steps now outrank stale semantic/task next-action text, preventing a new chat from repeating an already executed restart or other completed transition.
- Exposed `runtimeVersion` from the package manifest as live runtime authority and added the authoritative package version to consolidated memory.
- Reclassified legacy project memory as historical/non-authoritative context and documented the full authority order used during resume.
- Updated `context_bootstrap` tool guidance and added regression coverage for stale semantic next-action conflicts.


## 0.11.3 - 2026-09-27

- Memory Reconciler now safely normalizes an `expired` task to `completed` only when every recorded terminal step is verified, no active step remains, and final evidence explicitly indicates completion.
- Added an auditable `reconcileExpiredCompletion` transition in Task Runtime; each repair appends a reconciliation checkpoint instead of silently rewriting history.
- Incomplete or ambiguous expired tasks remain expired; interrupted or failed terminal steps block automatic completion repair.
- Added regression coverage for both the successful repair path and the incomplete-task safety boundary.
- Full MCP regression passes 197/197 with zero failures or skips.
## 0.11.2 - 2026-09-27

- Fixed cross-chat resume state so a semantic checkpoint with no next action clears stale workspace.next_action.
- Completed-task lifecycle now moves terminal task identity to working.last_task.* and clears working.current_task.* when no active task remains.
- Added freshness classes and TTL expiry for transient runtime, Office, browser, operational and current-document facts while preserving durable/project facts.
- Added bounded automatic synchronization of the latest semantic checkpoint into each project's .nhd\memory.md without replacing user-maintained project memory.
- Added a Memory Reconciler that refreshes active task state, expires stale facts, clears stale objectives, and flags expired tasks that contain verified completion evidence without rewriting their audit state.
- Expanded context_checkpoint structured facts with optional freshness/TTL and explicit clear_facts.
- Added regression coverage for all five Memory reliability fixes; full production suite passes 195/195, including active-step resume precedence after restart.
## 0.6.0 - 2026-09-13

- Added deterministic planning-only `WorkstationRouter` and public `workstation_plan`, selecting structured APIs before Browser DOM, Windows UI Automation and verified visual fallback.
- Added runtime capability snapshots so planning reflects actual write lock, Emergency Stop, Office app readiness, Browser executable, Desktop Companion and intake/PDF readiness.
- Added first-class verification/recovery primitives: `WorkstationVerifier`, `RecoveryController`, `RecoveryStateMachine`, and structured action receipts.
- Added `browser_wait_for` for URL/title/text/value/no-navigation post-conditions.
- Added `browser_click_verified` and `browser_fill_verified`: each action executes once, requires machine-checkable verification and fresh DOM evidence, and never repeats automatically after an ambiguous outcome.
- Verified fill receipts record character count without echoing filled text.
- Added pre-action Browser selector identity checks; stale controls are rejected when tag/type/name/text/href identity changes.
- Rejected v0.6.0-rc1 after live validation exposed Edge `edge://sync-confirmation-dialog/` target drift. RC2 adds controlled-target affinity and avoids generic fallback to Edge/Chrome internal pages.
- Added six dedicated Browser target-affinity tests; final v0.6 suite contains 94 passing tests with zero failures/skips.
- Increased production MCP registry from 62 to 66 tools.
- RC2 candidate validation: SHA-256 manifest clean, 94/94 tests passed, candidate server reported 0.6.0/66 tools, and verified Browser live smoke passed on an isolated Edge profile/port.
- Deployed only `dist`, `package.json`, and `package-lock.json`; Office bridge and Electron launcher were intentionally unchanged.
- v0.6 cutover added pending-action=0 preflight gating and used the proven WMI-owned external helper with automatic rollback to v0.5.0.
- Production post-deploy verification: 0.6.0, 66 tools, tunnel Online at https://mcp.nhdmcp.io.vn, Office/Screen/Desktop companions connected, pending actions 0, 94/94 production tests passed, 74/74 deployment files matched RC2 hashes, and production Browser verified-action live smoke passed.
- Stable v0.5.0 rollback backup: `deploy-backups\v060-20260913-194518`.

## 0.5.0 - 2026-09-13

- Added dedicated Chromium Browser automation through CDP with isolated browser profile, explicit HTTP/HTTPS navigation, DOM inspection, safe text fill, bounded waits and viewport screenshots.
- Added semantic browser action safety. Dangerous labels remain blocked and controls are also blocked when their DOM semantics indicate form submission, file upload, download, external-protocol/script links, credentials or other sensitive actions.
- Browser end-to-end smoke verifies safe navigation/fill/click while blocking Delete, a harmless-labelled form submit (`Continue`), download controls and password fields.
- Added confirmation-protected Word Live Write: preview captures an exact active-selection fingerprint; apply fails when the selection changes, replaces only the confirmed selection and reads Word again to verify the result.
- Added Office Companion authentication on both `/status` and `/action` using the shared workstation companion secret. Electron's Office availability probe now sends the authenticated header as well.
- Office Live Write end-to-end validation replaced `beta` with `BETA_OK`, verified the resulting selected range, and confirmed one-time token reuse is rejected.
- Preserved v0.4.2 Terminal lifecycle protections and v0.4.1 tunnel watchdog behavior.
- Production MCP registry increased from 53 to 62 tools: 7 Browser tools plus 2 Office Live Write tools.
- Built immutable release candidate `release-candidates\v0.5.0-rc2` with SHA-256 manifest. Candidate changed 19 `dist` files versus v0.4.2 plus the Office bridge, Electron launcher and package manifests.
- Candidate validation: 29 passed, 0 failed, 0 skipped; Browser smoke passed; authenticated Office Live Write smoke passed; candidate server reported `0.5.0 / 62 tools` on isolated staging while production v0.4.2 remained Online.
- Deployed with a WMI-owned external cutover helper, automatic v0.4.2 rollback, clean Electron restart and mandatory version/tunnel/companion/tool verification.
- Production post-deploy verification: version `0.5.0`, Cloudflare Tunnel Online at `https://mcp.nhdmcp.io.vn`, 62 live tools, Office/Screen/Desktop companions connected, Browser runtime ready, release files matching the candidate 67/67, and full production regression 29 passed / 0 failed.
- Production Browser semantic smoke passed after deployment.
- ChatGPT connector note: the live `/api/tools` registry reports 62 tools, but a conversation whose connector schema was mounted before the upgrade can remain pinned to its original function list. This is a client/harness schema cache, not a server registry failure; a newly mounted connector session/chat is required to expose the new function schemas to the model.

## 0.4.2 - 2026-09-13

- Fixed TerminalService concurrency slots being held indefinitely when a PowerShell launcher exited but a long-lived descendant inherited stdout/stderr handles.
- Terminal runs now finish shortly after the PowerShell launcher emits `exit` instead of waiting forever for descendant-inherited pipe handles to close.
- Added stale PID pruning before terminal concurrency enforcement and while listing active runs, allowing the service to self-heal dead launcher entries without restarting MCP.
- Improved `terminal_cancel` reconciliation so a cancelled run is removed when its launcher PID is no longer alive.
- Added regression coverage for long-lived descendants, stale dead-launcher entries, and recovery when all three terminal slots are stale.
- Recovered three stuck v0.5 staging launcher slots without restarting production by identifying and stopping only the staging listeners on ports `39110`, `39112`, and `39113`; production port `39100` was left untouched.
- Backported only `terminal.js`, `terminal.d.ts`, and `terminal.js.map` onto the v0.4.1 baseline so Browser and Office Live Write v0.5 work did not leak into production.
- Preserved the current 53-tool production baseline, including `office_live_read`, while explicitly excluding Browser and Office Live Write v0.5 tools.
- Completed the cutover with an external WMI-owned helper so restart/recovery no longer depends on the MCP process that is being stopped.
- Post-cutover verification confirmed version `0.4.2`, Cloudflare Tunnel Online at `https://mcp.nhdmcp.io.vn`, 53 tools, and production TerminalService hash matching the staged candidate.
- Live smoke test: a PowerShell launcher that spawned an 8-second descendant returned in about 0.31 seconds, proving the inherited-pipe slot leak is fixed in the running production process.
- Production baseline regression after deployment: 26 passed, 0 failed, 2 intentionally skipped v0.5 Word Live Edit tests.

## 0.4.1 - 2026-09-13

- Hardened Cloudflare Tunnel recovery after observed `cloudflared` exits with Windows exit code `4294967295` (`-1`).
- Added a tunnel watchdog with bounded exponential backoff (`2s -> 5s -> 10s -> 30s -> 60s -> 120s -> 300s`) and automatic retry only while the owner still wants the tunnel running.
- Manual tunnel stop, Emergency Stop and intentional runtime shutdown suppress automatic restart so the watchdog never fights owner actions.
- Preserved the tail of `cloudflared` stdout/stderr and added audit events for start, stop, process error, scheduled restart and stable recovery.
- Reset retry backoff after a stable connection interval instead of continuously increasing delays after transient failures.
- Migrated legacy persisted `cloudflaredPath` values from the ChatCode runtime to the MCP-owned `runtime\cloudflared.exe`, removing an unnecessary cross-application dependency.
- Upgraded the production Cloudflare connector binary from `cloudflared 2026.8.2` to `2026.9.1`; production now uses the project-owned binary.
- Added regression coverage for crash recovery, retry backoff, manual-stop suppression and Emergency Stop suppression.
- Deployed through a backup-first cutover with automatic rollback support; post-cutover health verified version `0.4.1`, named tunnel Online at `https://mcp.nhdmcp.io.vn`, and `restartAttempt=0`.

## 0.4.0 - 2026-09-13

- Added Windows UI Automation based desktop navigation with short-lived selectors, bounded control inspection, safe text entry, approved navigation keys, window activation and action auditing.
- Added an owner-controlled visual click fallback for applications such as Chromium sidebars that do not expose their controls. Clicks use normalized coordinates constrained to the selected top-level window and must be verified by a subsequent observation.
- Added `AutomationElement.FromPoint()` preflight for visual clicks. The companion now rejects points outside/covered over the selected window, blocks recognizable dangerous controls, and returns hit-test metadata for post-action verification.
- Added approved read-only intake folders with recent-file discovery, temporary-download rejection, junction blocking, stable-size detection, MIME metadata and SHA-256 correlation.
- Added public PDF inspect/read/search/render/OCR actions. Native text extraction is always available; rendering and OCR report their actual local worker readiness.
- Added `desktop_document_intake` for application/conversation/latest-PDF workflows with resumable diagnostic stages.
- Expanded dashboard permissions and the Desktop & Intake view with live companion, inbox, PDF and OCR status. MCP registry now exposes 52 tools.
- Fixed companion lifecycle so the Electron-owned backend is stopped with the app and Screen/Desktop Companion starts on every app launch.
- Persisted the owner's tunnel Start/Stop choice across normal restarts, kept Emergency Stop authoritative, and removed the internal companion secret from the localhost dashboard configuration response.
- Added regression tests for intake boundaries, PDF extraction, desktop owner controls and the new MCP registry surface.

## 0.3.1 - 2026-09-12

- Added a dashboard **Tools** page and localhost `/api/tools` endpoint backed by the live MCP tool registry. It reports all 46 registered tools and effective status under current Skills, Screen, Terminal, write-lock and Emergency Stop settings.
- Made `package.json` the single source of version metadata for HTTP health, the `workstation_health` tool, and MCP protocol initialization.
- Fixed multi-DOCX node collisions by migrating `document_nodes` to the composite identity `(document_id, id)` and constraining FTS joins by both fields.
- Added paragraph nodes and kind-aware semantic ranges: paragraph, clause, article and chapter edits now stop at their correct structural boundary.
- Made context packs strictly budgeted with `usedTokens`, `remainingTokens`, omitted-item accounting and complete-semantic-block trimming.
- Made offline DOCX apply transactional: build and validate a temporary DOCX/map before replacement, then restore the original if map commit fails.
- Extended durable edit passes with affected nodes and lifecycle status, bounded project status, and projection correctness.
- Added QA for duplicate/missing articles and clauses plus invalid Article/Clause/Point references.
- Added regression coverage for multi-document isolation, range edits, context budgets, atomic failure injection, restart persistence, QA and a real DOCX-copy workflow.

## 0.3.0 - 2026-09-12

- Added adjacent `.nhd` project state with SQLite authority and readable projections.
- Added durable decision statuses, explicit confirmation, project source snapshots and state snapshots.
- Added structured DOCX chapter/article/clause mapping with stable OOXML anchors and dependency graph extraction.
- Added bounded context planning, edit sessions, semantic DOCX edit preview/apply and document consistency QA.
- Preserved all v0.2.2 security and compatibility behavior; added v0.3 regression coverage.

## 0.2.2

- Stabilized Screen Companion startup when another listener owns the port.


