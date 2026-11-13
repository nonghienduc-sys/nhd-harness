---
name: vietnam-admin-documents
description: Use when drafting, editing, formatting, checking, or exporting Vietnamese administrative documents such as công văn, tờ trình, báo cáo, thông báo, kế hoạch, biên bản, giấy mời, quyết định, UBND commune-level documents, official Vietnamese government style, dates, recipients, signers, nơi nhận, or formal public-sector language. Apply Nghị định 30/2020/NĐ-CP style expectations for document structure and presentation, especially for công văn and other administrative documents.
---

# Vietnamese Administrative Documents

Trigger cues:

- "công văn", "tờ trình", "báo cáo", "thông báo", "kế hoạch", "biên bản", "giấy mời", "quyết định"
- "UBND", "Kính gửi", "V/v", "Nơi nhận", "CHỦ TỊCH"
- Formal Vietnamese administrative or public-sector writing
- Requests to follow Nghị định 30, thể thức văn bản hành chính, or kỹ thuật trình bày văn bản nhà nước

Use a formal Vietnamese public-sector tone. Avoid overly friendly wording.

Primary rule set:

- Follow the spirit of **Nghị định 30/2020/NĐ-CP** for administrative-document structure.
- Prioritize a correct, complete draft structure over decorative prose.
- Do not invent authority, legal basis, document number, signer title, urgency level, or confidentiality marking.

Do not trigger when:

- The user only asks for a casual message, chat reply, or informal reminder.
- The text mentions a government office but does not request an administrative document or formal style.
- The user wants a general business memo rather than a state/public-sector administrative document; use `office-word-writer`.

Core workflow:

1. Identify document type: công văn, báo cáo, kế hoạch, giấy mời, biên bản, thông báo, tờ trình, quyết định.
2. Preserve required dates exactly. Do not replace with today's date unless the user asks.
3. Apply the core administrative components when appropriate:
   - Quốc hiệu và Tiêu ngữ.
   - Tên cơ quan, tổ chức ban hành.
   - Số, ký hiệu văn bản.
   - Địa danh và thời gian ban hành.
   - Tên loại và trích yếu nội dung văn bản.
   - Nội dung văn bản.
   - Chức vụ, họ tên và phần ký của người có thẩm quyền.
   - Dấu/chữ ký số của cơ quan, tổ chức when relevant to the format.
   - `Nơi nhận`.
4. For công văn, prefer this order:
   - issuing agency,
   - number/symbol line,
   - national motto block,
   - place/date,
   - title and `V/v` line,
   - `Kính gửi`,
   - numbered or clearly separated body sections,
   - `Nơi nhận`,
   - signer title and signature placeholder.
5. Use concise, official language. Prefer "đề nghị", "yêu cầu", "tổ chức thực hiện", "tổng hợp báo cáo".
6. If exporting, pair with `daily-document-workspace`. If the user wants a Word file/template, pair with `docx`.

Quality checks:

- The required date is correct.
- The signer title matches the user's instruction.
- The document contains all requested sections.
- No casual phrases remain.
- The document does not silently fabricate missing authority-sensitive values.

Common templates:

- Công văn: issuing agency, number, national motto, date, `V/v`, `Kính gửi`, body, `Nơi nhận`, signer.
- Giấy mời: inviting agency, time, place, participants, content, requester, contact if needed.
- Báo cáo: basis/context, results, limitations, recommendations, next steps.
- Biên bản: time/place, participants, contents, conclusions, signatures.
- Thông báo: issuing agency, date, title, announcement body, implementation note, signer.
- Tờ trình: issuing agency, date, title, kính trình/kính gửi line when appropriate, grounds, proposal, signer.

If information is missing:

- Use formal placeholders such as `....................` only when the user did not provide a value and the draft can still be safely produced.
- Do not ask follow-up questions unless the missing field is required for legal/official validity and cannot be safely left as a placeholder.
- Never invent: document number, specific legal basis, signer identity, title, urgency level, classification, or addressees.

Date rule:

- If the user provides a fixed date, keep it exactly.
- If the user says not to use today's date, verify no current date appears in the final document.
- If the user does not provide a date, use today's date only when appropriate for a draft.

Interaction with other skills:

- Use `office-legal-reference-pack` when the user asks for legal basis, căn cứ, or cited normative support.
- Use `office-template-library` when the goal is a reusable template collection rather than one filled document.
- Use `daily-document-workspace` for saving/exporting.
- Use `docx` for Word-file output or template generation.
- Do not let a storage skill alter formal document wording.
- Follow the contract in `OUTPUT_CONTRACTS.md`.
