# NHD Vietnamese Administrative Document Pipeline v1

## Mục tiêu và phạm vi

Dây chuyền từ tiếp nhận nguồn → giải quyết quy định → soạn thảo → áp template → định dạng → structural QA → visual QA → **chờ con người duyệt và trình ký**. Cơ sở: canonical `viet-admin-format-checker`, registry `registry/skill-capabilities.v1.json`, engine `src/admin-document-orchestrator.ts`.

Đây là **mã điều phối và hợp đồng adapter** có thể build/test trong NHD; bản v1 **không tự ký, đóng dấu, cấp số hoặc gửi Outlook/QLVB**. Các bước tạo/sửa DOCX thật chỉ thực thi khi runtime cung cấp adapter hợp lệ và Safety cấp quyền từng thao tác.

## Thứ tự nguồn điều chỉnh

1. Biểu mẫu bắt buộc cụ thể.
2. Quy định chuyên ngành trực tiếp.
3. Quy định chương trình/thủ tục.
4. Quy định địa phương/cơ quan.
5. Nghị định 30/2020 khi thuộc phạm vi áp dụng hoặc phần không xung đột.
6. Quy định nội bộ hợp lệ.
7. Gợi ý trình bày.

Không mặc định NĐ30 áp cho văn bản Đảng, văn bản quy phạm pháp luật hoặc biểu mẫu chuyên ngành. Nếu văn bản cần mẫu bắt buộc mà chưa xác minh được, fail-closed. Không tự điền số/ký hiệu chính thức, người ký, con dấu hoặc căn cứ chưa xác minh.

## Bộ điều phối

| Giai đoạn | Skill được **kích hoạt** bởi adapter NHD | Backend thực thi đề xuất | Cổng kiểm tra |
|---|---|---|---|
| intake | `office-scan-ocr-intake` khi nguồn scan | document_qa/index, pdf_document, Outlook đọc | Intake receipt |
| legal_resolve | `viet-admin-format-checker`, `office-legal-reference-pack` | tài liệu nguồn, cổng pháp lý chính thức | Nguồn xác minh + resolved spec + provenance |
| draft | `vietnam-admin-documents` | Hermes drafting | Draft hash + trích nguồn |
| template | `viet-admin-docx-template-builder` | DOCX/Hermes | Template ID + DOCX path |
| format | `viet-admin-format-checker` | Hermes microsoft-office hoặc NHD office_live | Safety, lease, expected version, text diff, read-back |
| structural_qa | `office-workflow-qa` | DOCX XML validator độc lập | 0 mandatory errors, nội dung không đổi |
| visual_qa | Không cần skill mới | Word Live, PDF rendering | Prewrite Safety cho PDF/PNG, visual receipt, 0 layout errors |
| human_review | Không tự kích hoạt skill | cán bộ kiểm tra/văn thư/QLVB | Chờ ký, cấp số, dấu, phát hành |

### Cơ chế runtime thực tế

1. `buildAdminDocumentPlan(request, registry)` xác nhận **canonical bật**, **legacy bị tắt**, và các skill được tham chiếu có trong registry.
2. `executeAdminDocumentPlan(plan, adapter)` gọi `adapter.activateSkill(id, purpose)` qua NHD `skills_activate` cho từng skill của từng bước. Đây là **kích hoạt hướng dẫn** chứ không tự động đồng nghĩa đã tạo/sửa văn bản.
3. `adapter.executeStep` là tuyến thực thi thực tế, nối với document_qa, Hermes, Office Live, PDF; host triển khai phải dùng permission/lease và cung cấp receipt đầy đủ.
4. Trước mỗi bước write, `adapter.authorizeWrite` **bắt buộc** trả `approved=true`, `leaseValid=true`, `versionBound=true`. Không có adapter hoặc bất kỳ điều kiện nào sai ⇒ dừng.
5. Trước khi sang bước tiếp theo, receipt phải chứng minh đủ hậu điều kiện. Một lỗi ⇒ dừng, **không tự retry** và không đổi tool để né Safety.
6. Kết thúc QA trả `awaiting_human_approval`, **không có thao tác ký, đóng dấu, cấp số, gửi/submit** trong engine.

### Input contract

`AdminDocumentRequest`: `docType` thuộc 6 loại, `subject`, `documentId` (mã nội bộ dự thảo, **không phải số phát hành**), `agency`, `sourceReferences`, `sourceIsScan`, `requiresSpecializedTemplate`, `mandatoryTemplateRef`, `currentDocumentVersion`, `expectedTextHash`, `confidential`.

`AdminSkillRegistry` có `routing.canonicalAdminFormatter`, danh sách skill kích hoạt và alias legacy. `documentId` chỉ theo dõi task, không tự biến thành số ký hiệu.

### Bản ghi hậu kiểm

- Legal: `legalVerified`, `resolvedSpecId`, `sourceProvenance`, và `templateVerified` nếu bắt buộc.
- Draft: `draftHash`, `contentSourcesBound`.
- Template: `docxPath`, `templateId`, `normalizedTextHash`.
- Format: `preEditTextHash`, `postEditTextHash`, `versionMatched`, `readBackCompleted`. Hai text hash phải bằng nhau **và** khớp `normalizedTextHash` từ bước template. Mỗi thao tác ghi bắt buộc có `currentDocumentVersion` để host kiểm tra expected-version binding; không có thì từ chối ghi.
- Structural QA: `mandatoryErrors=0`, `contentUnchanged=true`, `qaReportId`.
- Visual QA: `visuallyReviewed=true`, `layoutErrors=0`, `renderReceiptId`.

Mọi receipt do backend cung cấp, không do LLM tự suy đoán là đã thành công. Với tài liệu mật: kiểm tra quyền/chính sách xử lý trước khi gửi đến bất kỳ backend ngoài máy nào; pipeline không vượt quyền này.

## Khởi động kiểm chứng

```powershell
cd D:\ChatGPT-Workstation-MCP
node scripts/build-admin-skill-registry.mjs --check
npm run build
node scripts/admin-document-plan.mjs --type cong_van --subject "Phối hợp báo cáo" --id draft-demo
node --test test/admin-document-pipeline.test.mjs
```

Giới hạn: CLI tạo **kế hoạch**, không sửa Word. Việc xuất DOCX, structural QA trên file thật và visual QA Word/PDF đòi hỏi adapter runtime/Office thực và kiểm soát quyền. Test mock chỉ xác nhận hợp đồng điều phối; không chứng nhận pháp lý cho một văn bản thực tế.

**Không chỉnh sửa file `skills/office-*`**. Các skill đó chỉ được tham chiếu bằng ID và kích hoạt qua host trong tương lai.
