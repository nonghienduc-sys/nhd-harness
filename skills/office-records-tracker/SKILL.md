---
name: office-records-tracker
description: Use when tracking incoming/outgoing documents, registry numbers, office correspondence, due dates, document status, issuing units, receiving units, filing logs, office work queues, or records-management style workflows.
---

# Office Records Tracker

Trigger cues:

- "công văn đến", "công văn đi", "sổ văn thư", "đăng ký văn bản", "hồ sơ", "lưu trữ"
- "registry", "records", "tracking", "sổ theo dõi", "số đến", "số đi"
- Requests to build or manage office correspondence trackers and filing status

Use this skill for office records-management workflows and document tracking logic.

Workflow:

1. Identify tracking scope: incoming, outgoing, internal, archive, or mixed.
2. Define required fields: registry number, date, sender, recipient, subject, status, due date, file location, handler.
3. Keep status values simple and consistent.
4. If implementing as a table/sheet, pair with `office-excel-ops`.
5. If saving outputs, pair with `daily-document-workspace`.

Do not trigger when:

- The task is just writing one document.
- The task is only OCR extraction.
- The task is only an informal reminder list.

Interaction with other skills:

- Use `office-excel-ops` for spreadsheet design or formulas behind the tracker.
- Use `daily-document-workspace` for saved logs and exports.
- Use `office-scan-ocr-intake` when registry pages are scanned and must be extracted first.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Required registry fields are explicit.
- Status values and numbering logic are consistent.
- Missing dates or handlers are marked clearly, not invented.
