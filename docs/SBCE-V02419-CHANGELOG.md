# NHD SBCE v0.24.19 — Implementation and verification

Date: 2026-11-12. User decisions Q1–Q6 in `docs/STRONG-BRAIN-CHEAP-EXECUTOR-2026-11-12.md` are unchanged.

## What changed (source candidate, not an automatic production update)
- Owner-scoped job list/status and Brain review retrieval: every job read now requires the originating task_run_id. The worker no longer publishes an unowned jobs list, and admin reporting exposes aggregates only.
- `SbceStore` now reserves cost before each model call, settles when usage is returned, and conservatively charges the ceiling for ambiguous requests. Interrupted calls are reconciled at process restart. Budget day boundary follows Asia/Ho_Chi_Minh.
- `sbce-budget.ts`: estimated upper bounds on input/output tokens; `sbce-catalog.ts`: disabled-by-default models, fresh authenticated pricing/audit evidence and explicit owner approval required for enabling.
- `sbce-runner.ts`: bounded retries with unique draft artifacts, structured cross-family L1 judge and T1→T2→T3 cascade. No implementation falsely marks code machine checks passed.
- `executor_admin eval_report` returns privacy-safe aggregate job/model-call telemetry; reports explicitly state no Golden Set model benchmark yet.
- SBCE worker stops on Emergency Stop; startup respects active Emergency Stop.
- Public HHTECH catalog template updated (no models enabled); release version 0.24.19.

## Evidence and remaining work
- Full npm test results to be recorded in task checkpoint and candidate smoke.
- No HHTECH key was read or sent; no paid inference performed.
- The next required gate is authenticated account model/pricing calibration and an isolated code worktree verifier, before enabling code changes in `shadow`.
- Project RAG context pack, verified failure learning, model bandit statistics, user-approved on-mode, and Lite repackaging remain open.
- Production v0.24.18 is unchanged by source build/stage. Every cutover or restart requires separate explicit approval.

## Source
`D:\ChatGPT-Workstation-MCP`, `src/sbce-*.ts`, `src/mcp-registries/delegation-tools.ts`, `test/sbce-*.test.mjs`.

## Staging and isolated release acceptance
- Full regression: 603/603 PASS on 2026-11-12 (following the lightweight readiness probe improvement for an intermittently slow parallel startup test).
- Immutable candidate: `v0.24.19-9265e8e2da17`.
- Atomic smoke: PASS (18 assertions), receipt `deploy-backups/atomic-release-v0.24.19-9265e8e2da17-smoke.json`.
- Atomic verify: PASS; current remains `v0.24.18-a57e1c16e6a7`, candidate verified.
- MCP live-contract on candidate: PASS both default `off` and isolated `shadow`; 99 advertised tools, legacy names preserved, remote `/mcp` rejects unauthenticated requests with 401. Shadow work order returned `needs_brain` without any paid API request, which is expected with zero calibrated models.
- HHTECH public docs confirm `https://hhtechapi.com/v1/messages` and `https://hhtechapi.com/v1/chat/completions`, but account-specific price and model entitlement remain unverified. The catalog template is disabled.
- This is a verified **candidate**, not completed P0–P6. Do not cut over/restart production without an additional explicit approval.

## Follow-up
1. Obtain owner-approved authenticated HHTECH billing evidence and model availability through a local protected UI; configure `shadow` only after the price gate.
2. Implement isolated machine L0 code worktree verifier and safe anti-tamper checks; do not execute generated code on the host.
3. Add bounded per-project RAG context, skill-specific QA and performance telemetry; measure genuine Golden Set accuracy and model costs.
4. Finish P0–P6 evaluation gates and Lite packaging. Any production cutover/restart needs separate approval.
