---
name: message-intake-tasks
description: Use when extracting tasks, deadlines, owners, stakeholders, decisions, blockers, waiting items, next steps, and follow-up messages from messy chat logs, Zalo, Telegram, email snippets, meeting notes, or multi-person operational messages.
---

# Message Intake To Tasks

Trigger cues:

- "tách việc", "rút việc", "bóc việc", "danh sách việc"
- "Zalo", "Telegram", "tin nhắn", "chat", "email", "log", "cuộc họp"
- Requests for deadline, owner, status, next step, blocker, follow-up

Turn messy messages into an operational task list.

Do not trigger when:

- The user asks only for a narrative summary and explicitly says no task list.
- The input is not a message/chat/log/meeting-note style source.

Workflow:

1. Read all messages in chronological order.
2. Extract each actionable item.
3. For each task, capture:
   - Task.
   - Deadline; write `chưa rõ` if missing.
   - Owner or likely responsible person.
   - Related people or units.
   - Status: not started, doing, waiting, blocked, done, or unclear.
   - Next step.
4. Separate:
   - Decisions already made.
   - Waiting/blocked items.
   - Follow-up messages to send.
5. If a deadline uses relative wording such as "hôm nay", convert it to an absolute date using the user's current date/timezone when available.
6. Do not invent missing owners or deadlines; mark uncertain fields clearly.

Preferred output:

- Short summary.
- Markdown table with 5-7 columns.
- Decisions.
- Waiting/blocked.
- Follow-up messages.

When saving outputs, use `D:/Không gian Ai/dd-MM-yyyy`.

Extraction rules:

- A message saying "ok" or "để Văn phòng tổng hợp" is a decision/assignment, not a separate task unless action remains.
- A partial completion note such as "đã có 3/5" means status is in progress and missing items should become waiting/blocked rows.
- For "nếu kịp", mark the task as conditional and status as unclear unless a responsible person is known.
- Preserve names and unit names exactly as written.

Final checks:

- Every task has a deadline field.
- Missing deadline is exactly `chưa rõ`.
- Every blocked item has a proposed unblock action.

Relative date rule:

- If the environment date is available, convert `hôm nay`, `ngày mai`, `thứ Sáu`, etc. to absolute dates.
- If the environment date is unavailable, keep the relative wording and mark the date basis as unclear.

Interaction with other skills:

- Use `daily-document-workspace` only if the user asks to save/export the extracted tasks.
- Use `vietnam-admin-documents` only when follow-up messages must become formal official documents.
- Follow the contract in `OUTPUT_CONTRACTS.md`.
