---
name: word-professional
description: Professional Microsoft Word document creation, editing, auditing, and training for .docx, .dotx, and .docm files. Use when Codex needs to work with Word documents or Vietnamese requests such as sua file Word, dinh dang Word, tao muc luc, header/footer, mail merge, comment, track changes, xuat PDF, luyen Word, bai test Word kho. Handles complex formatting, styles, templates, tables of contents, section/page setup, accessibility, PDF export, and finding difficult Word practice tests/exercises online.
---

# Word Professional

## Core Workflow

1. Preserve the original document unless the user explicitly wants in-place edits. Create a timestamped copy for risky changes.
2. Inspect existing structure before editing. Run `scripts/docx_audit.py <file.docx>` for complex documents to identify styles, headings, fields, comments, tracked changes, tables, images, headers, footers, and protection.
3. Choose the editing path by fidelity:
   - Use Word desktop automation on Windows when layout fidelity matters: TOC/fields, mail merge, tracked changes, comments, page numbers, section breaks, PDF export, or final pagination. Use `scripts/word_finalize.py` for field updates and PDF export.
   - Use OOXML/Python libraries for repeatable content edits, document generation, bulk table changes, metadata, and structural audits.
   - Use direct XML edits only for targeted changes that common libraries cannot preserve.
4. Keep professional document rules intact: styles first, direct formatting last; preserve section breaks; update fields after changing headings/captions/cross-references; keep headers and footers scoped to the intended section.
5. Verify visually when output quality matters. Reopen in Word, update all fields, review navigation headings, page breaks, table layout, comments/tracked changes, accessibility warnings, and exported PDF if requested.

## Common Tasks

- Long documents: normalize heading styles, rebuild navigation structure, update TOC, captions, cross-references, bookmarks, footnotes/endnotes, and bibliography fields.
- Templates: use `.dotx`/`.dotm` patterns, content controls, placeholder text, locked sections, theme fonts/colors, reusable style sets, and document variables where useful.
- Mail merge: validate the Excel source first, use stable field names, preview a small sample, handle blank fields deliberately, then merge to separate documents or a combined file as requested.
- Review workflows: preserve or create tracked changes/comments when requested; do not accept/reject changes unless explicitly asked.
- Professional output: check typography consistency, table readability, page setup, headers/footers, document properties, accessibility, and PDF bookmarks.

## Practice Mode

When the user asks to improve Word skills or get hard tests, browse current sources before selecting exercises. Prefer official Microsoft objectives and legitimate public practice files. Avoid exam dumps, answer-key scraping, or copyrighted paid material.

Build practice sets around Microsoft Word Expert domains:

- Manage document options and settings.
- Use advanced editing and formatting features.
- Create custom document elements.
- Use advanced Word features.

For each practice session, provide: source links, task brief, expected deliverables, scoring rubric, time limit, and a debrief checklist. Use `references/practice-sources.md` for curated starting points and refresh them with web search when the user wants new tests.

## Resources

- `scripts/docx_audit.py`: quick structural audit of a Word document without requiring Word to be installed.
- `scripts/word_finalize.py`: open a Word document in desktop Word, update fields/TOC/captions, save a copy, and optionally export PDF.
- `references/word-workflows.md`: detailed workflow notes for high-fidelity Word work.
- `references/practice-sources.md`: curated sources and search strategy for difficult Word exercises.
