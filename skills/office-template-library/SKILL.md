---
name: office-template-library
description: Use when creating, normalizing, cataloging, or saving reusable office templates such as report templates, email templates, form skeletons, checklists, meeting formats, and standard operating text blocks.
---

# Office Template Library

Trigger cues:

- "template", "mẫu", "thư viện mẫu", "standard", "boilerplate", "checklist chuẩn"
- "tạo mẫu dùng lại", "chuẩn hóa mẫu", "reusable format", "thư viện văn bản"
- Requests to create a reusable pattern rather than one single-use output

Workflow:

1. Identify reusable artifact type.
2. Separate fixed sections from variable placeholders.
3. Use clear placeholder conventions.
4. Include instructions for reuse when helpful.
5. Pair with `daily-document-workspace` for saving the template pack.

Do not trigger when:

- The user wants only one final filled document with no reuse intent.
- The task is a spreadsheet calculation problem.
- The task is OCR extraction.

Interaction with other skills:

- Use `office-word-writer`, `office-email-drafter`, or `office-meeting-pack` to derive the base content.
- Use `daily-document-workspace` to save template libraries.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Placeholders are obvious.
- Reusable parts are stable.
- No single-case details are accidentally baked into the template.
