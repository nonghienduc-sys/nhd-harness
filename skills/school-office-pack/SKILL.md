---
name: school-office-pack
description: Use when handling school-related office workflows such as school progress reports, student-related summary packs, facility issue logs, teacher/admin coordination, school deadline reminders, education reporting bundles, or commune-to-school operational follow-up.
---

# School Office Pack

Trigger cues:

- "trường học", "mầm non", "tiểu học", "THCS", "giáo viên", "học sinh"
- "báo cáo trường", "giáo dục", "school report", "deadline trường học"
- mixed school-office coordination involving reporting, reminders, tracking, and follow-up

Use this skill for school-related office workflows and reporting coordination.

Workflow:

1. Identify school-office context:
   - reporting progress,
   - missing school submissions,
   - teacher/admin coordination,
   - student/service summaries,
   - facility/issue logs.
2. Choose the working bundle:
   - `office-reporting-pack` for recurring reports,
   - `message-intake-tasks` for messy school-related messages,
   - `office-records-tracker` for submission status,
   - `office-email-drafter` or `vietnam-admin-documents` for reminders,
   - `daily-document-workspace` for saved outputs.
3. Keep school units and missing submissions explicit.
4. Prefer practical follow-up outputs over generic prose.

Do not trigger when:

- The task is generic office work with no school context.
- The task is a pure citizen intake or HR workflow.
- The task is only one simple email.

Interaction with other skills:

- Acts as a domain coordinator for school-office work.
- Hands content details to paired skills where needed.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Missing school/unit submissions are clear.
- Deadlines and follow-up actions are explicit.
- No student/school data is invented.
