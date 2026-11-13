---
name: office-email-drafter
description: Use when drafting, rewriting, formatting, summarizing, or saving office emails, reply chains, follow-up emails, escalation emails, reminder emails, or professional email templates for internal or external communication.
---

# Office Email Drafter

Trigger cues:

- "email", "mail", "thư", "reply", "follow-up", "cc", "subject"
- "soạn email", "trả lời mail", "nhắc việc qua email", "email nhắc hạn", "email xác nhận"
- Professional office communication that should remain email-shaped rather than document-shaped

Use this skill for business emails and reply-ready communication.

Workflow:

1. Identify audience: internal, external, leadership, vendor, partner, citizen, school, department.
2. Choose tone: concise, neutral, assertive, polite, escalation, or reminder.
3. Produce email structure:
   - Subject
   - Greeting
   - Purpose
   - Action requested / information shared
   - Deadline or next step
   - Closing
4. If requested, create variants: short, formal, assertive, softer, bilingual.
5. If saving/export is requested, pair with `daily-document-workspace`.

Do not trigger when:

- The task is a formal government administrative document.
- The task is a meeting minute, tracker, spreadsheet, or slide deck.
- The user only wants an SMS/chat-style message.

Interaction with other skills:

- Use `daily-document-workspace` for saved templates or email bundles.
- Use `message-intake-tasks` first if messy threads must become action items before drafting the email.
- Use `research-brief-with-sources` only if the email needs current sourced facts.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- The email has a clear subject and ask.
- The tone matches the audience.
- Deadlines and action owners are explicit when available.
- The email is easy to send with minimal edits.
