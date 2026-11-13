---
name: viet-admin-template-library
description: Use when creating a reusable library of Vietnamese administrative-document templates under Nghị định 30 style expectations, especially packs containing multiple mẫu such as công văn, thông báo, tờ trình, báo cáo, quyết định, biên bản, giấy mời, and kế hoạch.
---

# Viet Admin Template Library

Use this skill to build and normalize a reusable template collection for state/public-sector administrative writing.

Workflow:

1. Choose the template set scope:
   - core set,
   - expanded set,
   - or document-type-specific deep pack.
2. Separate each template into:
   - fixed structural blocks,
   - placeholders,
   - fill guidance,
   - notes on when the template should not be used.
3. Prioritize a strong công văn template first, then extend to:
   - thông báo
   - tờ trình
   - báo cáo
   - quyết định
   - biên bản
4. Expand later to giấy mời, kế hoạch, phụ lục, and other recurring forms.
5. Pair with `viet-admin-docx-template-builder` when the user wants Word-ready versions.
6. Pair with `daily-document-workspace` when saving a pack to disk.

Quality bar:

- Templates are reusable across cases.
- No one-off names, dates, numbers, or signers are hard-coded.
- Each template has a clear intended use.
- The pack does not confuse general office documents with administrative-state forms.

Do not:

- Treat one single completed document as a library.
- Claim legal certainty beyond the cited rule set.
- Mix casual/business memo patterns into the pack.

Useful pairing:

- `vietnam-admin-documents` for core drafting logic
- `office-template-library` for generic library-building discipline
- `docx` for actual Word outputs
- `office-legal-reference-pack` when the pack needs an attached legal basis summary
