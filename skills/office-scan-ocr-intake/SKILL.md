---
name: office-scan-ocr-intake
description: Use when extracting, cleaning, classifying, or structuring text from scanned office documents, photos of paperwork, PDFs, forms, receipts, letters, or low-quality document images before they become editable office records.
---

# Office Scan OCR Intake

Trigger cues:

- "scan", "OCR", "ảnh chụp tài liệu", "PDF scan", "trích xuất chữ", "làm sạch văn bản"
- "phiếu", "biểu mẫu", "hồ sơ scan", "giấy tờ", "tài liệu ảnh"
- Requests to convert scans into editable text or structured fields

Use this skill to normalize scanned or image-based documents into workable text and fields.

Workflow:

1. Identify source type: image, scanned PDF, form, receipt, letter, registry page.
2. Extract text and preserve uncertain areas as uncertain.
3. Normalize obvious OCR noise carefully without inventing missing data.
4. Separate raw extraction from cleaned extraction when confidence is low.
5. If saving outputs, pair with `daily-document-workspace`.

Do not trigger when:

- The source is already clean editable text.
- The task is mainly formatting a final document rather than extracting text.
- The task is primarily spreadsheet analysis or slide building.

Interaction with other skills:

- Use `daily-document-workspace` for saved OCR outputs.
- Use `office-records-tracker` if extracted registry fields must be entered into a records log.
- Use `vietnam-admin-documents` or `office-word-writer` only after extraction when a final polished document is needed.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Safety checks:

- Mark low-confidence text clearly.
- Do not guess names, dates, or codes when unreadable.
- Preserve source-to-output traceability.
