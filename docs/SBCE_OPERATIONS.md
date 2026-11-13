# NHD Strong Brain – Cheap Executor — Operations (source 0.24.18)

Date: 2026-11-12. Architecture source: `docs/STRONG-BRAIN-CHEAP-EXECUTOR-2026-11-12.md`.

## Verified scope

This is an **additive, fail-closed development candidate**. Production MCP endpoint (`/mcp`), OAuth, tunnel and existing tools remain unchanged. Default `NHD_SBCE_MODE=off`: executor does not start and new MCP tools return `disabled`. The live production release is not changed merely by building or staging source.

Implemented:
- Strong Brain facade: `delegate_task` (submit/status/list/cancel), `review_pack` (get/accept/revise/reject/pull bounded draft), `executor_admin` (status/budget/catalog).
- Child worker on loopback `127.0.0.1:39300`, random internal bearer header, bounded at 3 concurrent jobs, safe interruption recovery.
- HHTECH OpenAI-compatible and Anthropic Messages adapters, output/usage validation and secret egress guard.
- Windows CurrentUser DPAPI secret vault (key entered via local Dashboard only), at `<dataDir>/vault/sbce-hhtech.bin`. Never put API keys in MCP requests, chats, model catalog or shell args.
- SQLite job ledger, 20,000 VND/job and 300,000 VND/day budget reservation; owner-bound Brain acceptance; no model output can authorize apply.
- Sandbox-only draft/patch artifact generation; no code patch is executed, merged or applied by this release.
- Independent cross-family L1 evaluation for draft text, plus L0 artifact-shape check. Worktree/build/test L0 of model-generated code is **NOT implemented**: code jobs end `needs_brain`, never pass machine verification falsely.
- Test and dashboard scaffolding: `dashboard/sbce.html`, `test/sbce-*.test.mjs`.

## Non-goals and features still open

The P0–P6 design remains a **multi-phase implementation plan**. The current candidate is not a full autonomous code editor: no isolated code test/run or safe apply, no authenticated live provider model benchmarking, no dynamic model-bandit optimization, no full RAG context pack, no self-evolution or user-approved production cutover. `delegate_task answer` and `executor_admin eval_report` are placeholders. No claims of reduced real-world API cost without benchmark.

## Development/test instructions

From `D:\ChatGPT-Workstation-MCP`:

```powershell
npm run build
npm run docs:architecture
npm test
```

Never run the new `dist/server.js` on production port while the immutable release owns it. Build/source modifications do not activate the worker.

## Catalog and credentials

Candidate catalog template: `registry/sbce-model-catalog.template.json` (ALL models disabled). Runtime catalog, if later approved: `C:\ProgramData\ChatGPTWorkstationBridge\sbce-model-catalog.json`. Model IDs, prices, token cache, rate limits must be verified against authenticated HHTECH results; `vndPerM` placeholders are not authoritative billing.

After separately approved cutover and explicit mode change to `shadow`, open the local-only `http://127.0.0.1:39100/sbce.html` page, enter HHTECH key to save via DPAPI, activate only tested catalog entries, run shadow job through MCP. API calls consume HHTECH credits; every job has spend caps. The feature must remain `off` until verified.

## Safety checklist (must pass before production use)

- `/mcp`, OAuth and tunnel contract tests, old tools unchanged.
- `NHD_SBCE_MODE=off` makes zero paid API requests; legacy MCP functions operate as before.
- Secrets do not appear in tool results, logs, provider prompts or trace.
- Runtime service dies independently; no legacy MCP outage.
- `Redaction Guard`, job ownership, budget, agent approvals, Emergency Stop.
- Model-generated code is never executed or applied by the host without isolated L0 verification and existing preview/apply/authorization.
- Every production cutover or restart requires **separate, explicit user confirmation** even when stage and smoke pass.

## Recovery

When the child worker stops during a job, ambiguous `queued/running/verifying/fixing` states transition to `needs_brain` without replaying any action. A code proposal always stays a sandbox artifact. Disabling SBCE restores old MCP behavior; rollback of released code goes through existing atomic release workflow.

## Release pipeline

```powershell
npm run build
npm run docs:architecture
npm test
node scripts/atomic-release.mjs stage --version 0.24.18
& .\scripts\smoke-atomic-release.ps1
node scripts/atomic-release.mjs verify --release-id <candidate-id> --receipt deploy-backups\atomic-release-<candidate-id>-smoke.json
# STOP, request owner confirmation before any cutover/restart
```
