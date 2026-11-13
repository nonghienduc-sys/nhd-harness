---
name: office-word-writer
description: Use when drafting, editing, structuring, formatting, saving, or exporting office-style documents such as reports, proposals, meeting minutes, letters, memos, forms, templates, DOCX-like content, or Word-first business documents.
---

# Office Word Writer

Trigger cues:

- "Word", "DOCX", "văn bản", "báo cáo", "biên bản", "mẫu", "template"
- "soạn tài liệu", "chỉnh tài liệu", "định dạng văn bản", "thư mời", "memo"
- Office-style documents that are not strictly government administrative forms

Use this skill for general office documents with clear sections, headings, lists, tables, and reusable wording.

Workflow:

1. Identify document type and audience.
2. Build a clean structure: title, summary/purpose, main sections, appendix if needed.
3. Keep wording concise and businesslike.
4. If the user asks to save/export, pair with `daily-document-workspace`.
5. If DOCX export is unavailable, save as Markdown or TXT while preserving structure.

Do not trigger when:

- The task is a formal Vietnamese administrative document; use `vietnam-admin-documents`.
- The task is mainly spreadsheet, slide deck, OCR, or registry tracking work.
- The user only wants a casual chat reply.

Interaction with other skills:

- Use `daily-document-workspace` for final storage.
- Use `research-brief-with-sources` if the document needs current sourced facts.
- Do not override `vietnam-admin-documents` for official public-sector formatting.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- The document has a clear structure and purpose.
- Headings and lists are consistent.
- The output matches the requested audience and tone.
- Save/export format is stated clearly if a file is created.
