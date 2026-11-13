---
name: office-workflow-qa
description: Use when reviewing office workflows, templates, trackers, forms, bundles, or process outputs for missing fields, inconsistent statuses, deadline gaps, template defects, routing ambiguity, and operational readiness.
---

# Office Workflow QA

Trigger cues:

- "review", "QA", "kiểm tra", "soát lỗi", "thiếu trường", "không nhất quán", "readiness"
- "workflow", "tracker", "template", "form", "bundle", "quy trình văn phòng"
- Requests to audit quality, completeness, consistency, or operational risk

Workflow:

1. Identify artifact under review: template, tracker, form, document pack, workflow definition.
2. Check for:
   - missing required fields,
   - inconsistent statuses,
   - unclear ownership,
   - deadline ambiguity,
   - overwrite or versioning risk,
   - routing confusion.
3. Report findings concretely and prioritized.
4. Suggest fixes or missing tests.
5. If saving a QA report is requested, pair with `daily-document-workspace`.

Do not trigger when:

- The user asks to create the first draft rather than review it.
- The task is purely web research.
- The task is a simple one-off reminder.

Interaction with other skills:

- Use it after any Office skill when the user asks to review, audit, or verify the output.
- Use `research-brief-with-sources` only if current external standards must be checked.
- Use `daily-document-workspace` for saved QA reports.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Findings are specific.
- Gaps are actionable.
- No invented defects beyond what the artifact implies.
