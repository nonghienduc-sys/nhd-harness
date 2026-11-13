---
name: commune-office-operations
description: Use when handling commune-level office operations such as UBND xã workflows, thôn reporting, one-door intake coordination, periodic summaries, dispatch follow-up, cross-unit reminders, local administrative coordination, or mixed office tasks across citizen intake, reports, and official communication.
---

# Commune Office Operations

Trigger cues:

- "UBND xã", "thôn", "xã", "bộ phận một cửa", "báo cáo thôn", "đôn đốc"
- mixed commune-office tasks involving intake, reminders, reports, and coordination
- requests that combine administrative writing, tracking, and operational follow-up

Use this skill for end-to-end commune office coordination work.

Workflow:

1. Identify the commune-office scenario:
   - thôn progress reporting,
   - citizen intake coordination,
   - outgoing reminders,
   - incoming dossier handling,
   - cross-unit follow-up,
   - monthly operational summary.
2. Choose the operating bundle:
   - `vietnam-admin-documents` for official documents,
   - `office-citizen-intake-pack` for one-door/front-desk intake,
   - `office-records-tracker` for registry logic,
   - `office-email-drafter` or `message-intake-tasks` for coordination/follow-up,
   - `daily-document-workspace` for saved outputs.
3. Keep dates, responsible units, and next steps explicit.
4. Prefer practical office outputs over abstract analysis.

Do not trigger when:

- The task is clearly only one simple document or only one simple tracker.
- The task is unrelated to commune/public-sector office operations.

Interaction with other skills:

- Acts as a domain coordinator for commune-office work.
- Should hand off content details to the more specific paired skills listed above.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Responsible unit or person is explicit.
- Missing documents or deadlines are clearly marked.
- Follow-up and handoff steps are operational, not vague.
