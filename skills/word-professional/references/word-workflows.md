# Word Professional Workflows

## Editing Path Selection

- Use Word desktop automation when the task affects rendering: section breaks, headers/footers, fields, TOC, captions, cross-references, comments, tracked changes, mail merge, PDF export, or page-specific layout.
- Use `python-docx` or OOXML ZIP/XML edits when the task is structural and repeatable: inserting text, tables, styles, metadata, bulk replacements, or template generation.
- Use direct OOXML edits only when a library cannot preserve the needed construct. Keep a backup and make the smallest possible XML change.

## Quality Checks

- Use `scripts/word_finalize.py <file.docx> --pdf` when final output needs updated fields and Word-generated PDF pagination.
- Update all fields after heading, caption, bookmark, TOC, or cross-reference changes.
- Confirm section-specific headers/footers, page numbering, margins, orientation, and columns.
- Confirm style consistency through the Navigation Pane and Styles pane, not only visual appearance.
- For reviewed documents, preserve comments and tracked changes unless the user asks to accept/reject/delete them.
- For final delivery, export to PDF from Word desktop when pagination, fonts, bookmarks, and hyperlinks matter.

## Vietnamese Administrative Motto Rule in Word

When a Vietnamese administrative document uses the Nghị định 30 national-heading/motto block and the applicable higher-priority template/rule does not override it:

- The motto is `Độc lập - Tự do - Hạnh phúc`, centered and bold in the legally applicable size range.
- The horizontal rule beneath the motto must be a solid line whose **visible left edge begins exactly under the visible left edge of `Đ` in `Độc` and whose visible right edge ends exactly under the visible right edge of the final `c` in `phúc`**.
- Do **not** fake the rule with underscore characters (`_____`), underlined spaces, or underlined tabs.
- Preferred Word implementation: use a real **Shape Line / Straight Connector** anchored to the motto paragraph. Use black line color and a thin practical default such as `0.75 pt`; treat the weight as an implementation default, not as a statutory numeric requirement unless an applicable source explicitly specifies one.
- Do not assume `Shape.Left = 0`, paragraph start, cell start, or `Range.Start/End` gives the visible glyph bounds. In centered table-cell paragraphs, Word COM positioning can report paragraph/cell geometry instead of the visible glyph edge.
- Always perform **Word Live visual QA** after positioning. Acceptance criterion: the line begins under `Đ`, ends under the final `c` of `phúc`, and is neither longer, shorter, nor horizontally offset.
- If automation gives ambiguous geometry, keep the endpoint that is visually correct fixed and adjust the other endpoint in Word Live until both endpoints match the visible text bounds. Preserve a backup before bulk-applying the rule to multiple documents.

## Mail Merge Checklist

1. Validate the Excel source: one header row, stable column names, no blank header cells, no merged cells in the data range.
2. Insert merge fields using exact source headers.
3. Preview a small sample including blank/long values.
4. Decide how blanks are handled before merging.
5. Merge to a new document first, then split/export only after review.

## Professional Document Standards

- Prefer semantic styles over manual formatting.
- Keep body, heading, table, caption, quote, and appendix styles distinct.
- Use content controls for reusable templates and data-entry forms.
- Use bookmarks/cross-references for repeat content that must stay synchronized.
- Run accessibility checks for documents intended for external sharing.
