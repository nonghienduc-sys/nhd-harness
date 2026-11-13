---
name: office-citizen-intake-pack
description: Use when organizing citizen-facing intake workflows such as request intake, complaint logs, service counters, missing-document checklists, handoff notes, appointment follow-ups, and office front-desk processing bundles.
---

# Office Citizen Intake Pack

Trigger cues:

- "tiếp nhận", "người dân", "hồ sơ", "đơn", "khiếu nại", "phản ánh", "bộ phận một cửa"
- "missing documents", "checklist hồ sơ", "phiếu tiếp nhận", "counter", "appointment"
- Requests for intake workflow, checklist, handoff, or case status tracking

Workflow:

1. Identify intake type: complaint, service request, dossier submission, appointment, missing-doc follow-up.
2. Build a practical intake pack:
   - intake summary,
   - required documents checklist,
   - missing items,
   - responsible unit,
   - next step / appointment / handoff.
3. Mark uncertain or missing information clearly.
4. Pair with `office-records-tracker` if the case must enter a registry.
5. Pair with `daily-document-workspace` if saving/export is requested.

Do not trigger when:

- The task is only internal HR/admin work.
- The task is only a formal outgoing administrative document.
- The task is a pure OCR request with no intake workflow.

Interaction with other skills:

- Use `office-records-tracker` for registry logging.
- Use `message-intake-tasks` if messy citizen messages must first become structured actions.
- Use `vietnam-admin-documents` if the final output must be a formal official response.
- Use `daily-document-workspace` for saved intake packs.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Required documents are explicit.
- Missing items are separated from completed items.
- Next step and responsible side are clear.
