# NHD MCP v0.23 — Conversation Binding, Runtime Identity, Browser Target Routing

## 1. Conversation → Project → Task binding

The context resolver is no longer conceptually centered on one global `activeProjectRoot`.

Resolution priority:

1. Explicit conversation binding (`conversation_id → project root`).
2. Conversation task binding (`conversation_id → durable task`) when the task belongs to the same project.
3. A unique active durable-task project when a newly observed focused chat has no prior binding.
4. Legacy global `activeProjectRoot` only as a compatibility fallback.
5. Most recently opened project only when bootstrap has no stronger affinity.

`workspace_conversation_tasks` stores the task affinity separately from visible chat journal messages. Rebinding a conversation to another project clears an incompatible task binding. Context metadata is never authorization to execute workstation actions.

`context_bootstrap` accepts `conversation_id` and returns `bindingResolution`, including the selected root, task id/state/objective, resolution source, and whether the global fallback was used.

`context_chat_binding` may bind both a project and a `task_run_id`. `task_run create/start` may accept `conversation_id`; when omitted, it attempts a bounded recent-focused-conversation binding so the current ChatGPT conversation follows the durable task without relying on a global active project.

## 2. One runtime identity API

`runtime_identity` is the single read-only identity surface for deployment/version questions. It returns:

- `productionVersion` — live `VERSION` / `WORKSTATION_MCP_VERSION` authority.
- `sourceVersion` — current source `package.json` version.
- `candidateVersion` — staged candidate from environment or `runtime/deployment-manifest.json`.
- `runtimePath` — actual Node entrypoint path.
- `gitCommit` — current commit when a local Git checkout is available.
- `sourceHash` — deterministic source-tree SHA-256 unless overridden by deployment metadata.
- `deploymentHash` — deterministic built deployment-tree SHA-256 unless overridden.
- `rollbackVersion` and `rollbackPath` — declared rollback target.
- consistency flags showing source/production/candidate relationships.

`workstation_health` embeds the same `runtimeIdentity` object so health checks and explicit identity checks cannot silently use different version semantics.

Current staged manifest declares source/candidate `0.23.0` and production rollback baseline `0.22.1`. Production must not be cut over merely because source version is newer; regression and live verification remain required.

## 3. Browser target routing policy

Browser routing distinguishes the user's personal browser session from clean automation environments.

### Cốc Cốc extension (`coc_coc_*`)
Use when the task materially requires the user's existing login/session/cookies or explicitly refers to a page already authenticated in Cốc Cốc. Credentials/cookies are never copied into another browser to satisfy routing.

### Dedicated Chromium (`browser_*`)
Default for deterministic DOM automation, public/anonymous browsing, scraping, tests, and automation tasks that do not need the personal browser session.

### Isolated Browser (`isolated_browser_*`)
Use when isolation/GUI separation is required or explicitly preferred, and as the automation/scraping/testing route when dedicated Chromium is unavailable but the Isolated Agent is online.

For an explicit automation/scraping/testing workload, the router fails closed instead of falling back to the user's personal Cốc Cốc profile if neither dedicated Chromium nor Isolated Browser is available.

`workstation_plan` accepts:

- `requires_user_session`
- `browser_workload`: `auto | user-session | automation | scraping | testing`
- `prefer_isolated_browser`

and returns `browserTarget` as one of:

- `coc-coc`
- `dedicated-chromium`
- `isolated-browser`

Existing risk policy, sensitive-field blocking, task authorization, no ambiguous side-effect replay, and Background/Isolated foreground rules remain unchanged.

## 4. Compatibility contract

- `activeProjectRoot` remains for older callers but is a fallback, not the primary binding model.
- Existing generic route ids such as `browser.read` and `browser.navigate-safe` remain stable; `browserTarget` selects the concrete browser stack.
- Existing browser UIA/visual fallback behavior remains available when browser DOM is unavailable.
- No new mechanism grants execution permission; project/task/browser routing metadata only selects context and route.

## 5. Verification

Focused regression added for:

- conversation→project→task resolution and active-task-first chat ingestion;
- runtime identity API/tool registration, source/deployment hashes, candidate and rollback metadata;
- dedicated Chromium default for automation;
- Cốc Cốc selection for real logged-in sessions;
- fail-closed behavior when a personal session is required but Cốc Cốc is unavailable;
- Isolated Browser fallback for scraping/testing;
- refusal to consume the personal Cốc Cốc profile for explicit automation workloads;
- preservation of legacy Browser→UIA→visual fallback semantics.
