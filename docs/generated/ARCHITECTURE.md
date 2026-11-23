# Generated Architecture Contract

> GENERATED FILE. This document is derived from current source contracts and is protected by architecture drift checks.

Version: 0.24.47

## Runtime composition

- `WorkstationRuntime` is the single frozen process-scope dependency container supplied to stateless MCP protocol instances.
- MCP registration ownership is split across six domain registries: Execution, Files, Context, Office, Browser, and Media.
- `src/capability-registry.ts` is the deterministic source for tool group, permission, mutation/risk baseline, lane, runtime requirements, and runtime capability state.
- `UnifiedExecutionPlanner` composes Router, execution lane, risk policy, adaptive Office QA, Capability Registry metadata, and pure Tool Governor advice.
- Planning is read-only metadata: it executes no action and grants no authorization.
- Runtime-scoped Tool Governor preserves global capability visibility and Direct Fast Lane behavior.
- Connection model is `multi-harness-single-core-v1`: remote OAuth MCP and loopback/stdio harness traffic converge on the same process-scoped `WorkstationRuntime`.
- Remote MCP remains on the authenticated Cloudflare path; local harness MCP binds only to loopback and defaults to `127.0.0.1:39104`.
- OpenAI Secure MCP Tunnel is optional and targets the private loopback MCP without requiring NHD to persist a control-plane API key.

## Execution safety invariants

- Background host foreground policy: **blocked**.
- Background capabilities: `files`, `terminal-non-gui`, `office-direct`, `coc-coc-dom-background`, `pdf`, `ocr`, `local-ai`, `project-memory`.
- Background forbidden operations: `host-mouse`, `host-keyboard-injection`, `host-window-activation`, `coordinate-click`, `foreground-tab-switch`.
- Ambiguous/interrupted side-effect execution is never replayed automatically.
- Action tools continue to own preview/token/task-authorization/critical-confirmation enforcement.
- Adaptive Office QA does not silently convert visual verification into host foreground control.

## Deployment invariants

- Release model: `atomic-json-pointer-v1`.
- Candidate smoke verification is required before atomic promotion.
- Previous immutable release remains the rollback target after promotion.
- Generated docs are development/CI evidence; live runtime identity and capability endpoints remain authoritative for deployed state.

## Drift enforcement

- `npm run docs:architecture:check` fails when generated docs differ from current source.
- `npm run test:architecture` checks generated docs and cross-module architecture invariants.
- CI runs architecture checks on pushes and pull requests.
