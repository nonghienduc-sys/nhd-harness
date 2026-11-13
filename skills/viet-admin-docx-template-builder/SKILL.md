---
name: viet-admin-docx-template-builder
description: Use when the user wants a reusable DOCX-style template for Vietnamese administrative documents such as công văn, thông báo, tờ trình, báo cáo, quyết định, or biên bản, aligned with Nghị định 30 structure and ready for Word export or downstream DOCX generation.
---

# Viet Admin DOCX Template Builder

Use this skill when the user wants a Word-ready template rather than only chat text.

Workflow:

1. Identify document type and whether the user wants:
   - a blank reusable template,
   - a lightly prefilled template,
   - or a fully drafted document exported to DOCX.
2. Build a template with:
   - fixed structural blocks,
   - clearly marked placeholders,
   - short fill instructions when needed.
3. Follow the core administrative structure expected under Nghị định 30 style practice.
4. Prefer a highly reliable structure over decorative styling.
5. When generating a Word file, use safe defaults unless the user provides stricter local rules:
   - A4 page size,
   - Times New Roman,
   - main body around 13pt,
   - practical administrative margins,
   - obvious title / signer / nơi nhận blocks.
6. Pair with `docx` for actual Word-file creation.
7. Pair with `daily-document-workspace` if saving/exporting is requested.

Template rules:

- Never fabricate document number, signer identity, legal basis, or urgency/confidentiality marks.
- Use placeholders such as `....................` for values the user has not provided.
- For công văn, include at minimum:
  - cơ quan ban hành
  - số/ký hiệu
  - quốc hiệu/tiêu ngữ
  - địa danh, ngày tháng năm
  - tên loại / `V/v`
  - `Kính gửi`
  - nội dung
  - `Nơi nhận`
  - khối ký tên
- For other administrative forms, keep the same discipline: complete structure first, visual polish second.

Preferred output in chat before file creation:

- `Tên mẫu`
- `Mục đích dùng`
- `Phần cố định`
- `Phần cần điền`
- `Lưu ý trình bày`

Do not trigger when:

- The user wants only a quick legal/reference check.
- The user wants a casual or business-only document.

Pairing:

- `docx` for file generation
- `vietnam-admin-documents` for drafting the content to fill the template
- `office-template-library` if the user wants multiple related templates bundled together
