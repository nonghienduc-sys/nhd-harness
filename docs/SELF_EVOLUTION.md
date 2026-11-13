# NHD Self-Evolution Engine v1

## Purpose
The engine learns from **structured, verified feedback**, clusters repeated failures, and stages a deterministic correction to an existing SKILL.md. It is a controlled workflow-improvement mechanism, **not model-weight training, autonomous code execution, or an independent authority to deploy**.

## Trust boundaries
- The existing NHD Task Runtime, Emergency Stop, Skill Registry, file confirmation, Safety, permissions, and atomic release controller remain authoritative.
- No live skill, safety policy, access permission, runtime pointer, or release is modified by the self-evolution engine.
- A candidate lives under `<config.dataDir>/self-evolution/candidates/<candidateId>/`, never under live `skills/`.
- No raw user message, full document, terminal output, secret, or tool error text is stored. Event keys are task/skill/issue/outcome/source metadata only, deduplicated by SHA-256.
- Tool errors detected by the MCP wrapper are **unverified** and cannot autonomously justify skill modification.
- User-confirmed or QA-verified failures from **at least two distinct tasks** with the **same known issue code** are required to stage a candidate.
- A passed `self_evolution_evaluate` is a static integrity and rule check, **not final quality, legal, safety, or production approval**.
- Write tools fail closed if the NHD Emergency Stop is on or filesystem writes are not allowed.
- Human review, independently executed task-specific regression and visual QA, and standard NHD atomic release controls are separate gates; this engine never applies or promotes itself.

## MCP tools
- `self_evolution_status`: telemetry counts, issue count, and stage safety properties.
- `self_evolution_analyze`: analyze verified failures by skill, issue code, and distinct task count.
- `self_evolution_record_feedback`: record one structured outcome against an existing durable `task_run_id`; `verified` must reflect actual user correction or QA evidence.
- `self_evolution_propose`: stage an append-only, content-addressed candidate for a known remediation after the threshold is reached.
- `self_evolution_evaluate`: verify candidate/baseline hashes, append-only constraint, expected rule, repeated evidence, and disallowed directives.

## Initially supported issue codes
- `DOCX_JUSTIFY`: body paragraph alignment and mandatory visual confirmation.
- `DOCX_SHAPE_LINE`: actual anchored shape line geometry and page rendering.
- `DOCX_RELEASE_QA`: managed administrative document final-release receipts.
- `SKILL_DUPLICATE`: canonical skill choice and reversible legacy routing.

These are reviewed, deterministic corrections, not free-form AI-written code. Other issue codes may be stored but are **ineligible** for generation until a reviewed remediation is added in source.

## Example sequence
1. Register a confirmed corrective outcome: `self_evolution_record_feedback(task_run_id,skill_id,issue_code,outcome="failure",source="user_correction",verified=true)`.
2. Register independent verified evidence from a separate task with the same issue code.
3. `self_evolution_analyze` should mark it eligible.
4. `self_evolution_propose` writes only `SKILL.md.candidate` plus `manifest.json`.
5. `self_evolution_evaluate` checks static integrity; an independent specialist then reviews the proposal, tests real documents, and checks output visuals.
6. Only after human review and standard production QA may a separate, appropriately authorized operator integrate an approved change through NHD's existing release system.

## Test / rollback
- `npm test` includes deterministic privacy, repeat-threshold, integrity/tampering, and nondeployment checks.
- `npm run docs:architecture:check` verifies the exact registered 154-tool catalog.
- `node scripts/self-evolution-release-smoke.mjs` checks a staged, immutable release package without editing production and produces a SHA-256 evidence receipt.
- Production rollback is handled **only** by the existing independent atomic release controller, not by this engine.

## Limitations
The engine cannot infer user preferences from arbitrary conversations without consent or verified metadata. It cannot certify real Word page positioning; the full DOCX managed-release and visual inspection workflow remains necessary. It does not automatically install external GitHub repos, write arbitrary source patches, train a model, or silently promote improvements.
