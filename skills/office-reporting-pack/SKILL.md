---
name: office-reporting-pack
description: Use when preparing periodic office reports such as daily, weekly, monthly, quarterly, annual, progress, status, summary, implementation, or leadership reporting packs that combine narrative summary, metrics, blockers, actions, and appendices.
---

# Office Reporting Pack

Trigger cues:

- "báo cáo tuần", "báo cáo tháng", "báo cáo quý", "tổng hợp", "progress report"
- "summary report", "status report", "implementation report", "leadership update"
- requests for recurring or structured reporting packs rather than one-off notes

Use this skill for periodic office reporting bundles.

Workflow:

1. Identify reporting period and audience.
2. Structure the report:
   - scope,
   - results achieved,
   - pending items,
   - blockers/risks,
   - next actions,
   - optional table/appendix.
3. If metrics or tracker data are involved, pair with `office-excel-ops`.
4. If the report is formal public-sector style, pair with `vietnam-admin-documents` or `office-word-writer` as needed.
5. If saving/export is requested, pair with `daily-document-workspace`.

Do not trigger when:

- The task is only a short email update.
- The task is a slide deck rather than a report.
- The task is a single isolated message summary.

Interaction with other skills:

- Use `office-word-writer` for polished narrative structure.
- Use `office-excel-ops` for metrics tables.
- Use `message-intake-tasks` if messy messages must first become action items.
- Use `daily-document-workspace` for saved report bundles.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Reporting period is clear.
- Results, blockers, and next steps are separated.
- Missing metrics are marked clearly, not invented.
