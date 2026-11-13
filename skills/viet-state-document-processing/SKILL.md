---
name: viet-state-document-processing
description: End-to-end NHD Harness workflow for processing an incoming Vietnamese state document (văn bản đến từ Bộ/Sở/UBND cấp trên) - intake, rà soát nội dung và thể thức so với văn bản cấp trên, xác định vai trò đơn vị nhận, soạn văn bản triển khai (kế hoạch, công văn, báo cáo, thông báo) và bắt buộc đi qua release gate trước khi phát hành dự thảo. Use when the user gives a zip/PDF of a công văn, says "xử lý văn bản này", "rà soát công văn", "soạn kế hoạch triển khai", "UBND xã/phường nhận", or wants any model to produce a state document that passes NĐ 30/2020/NĐ-CP checks through the harness.
---

# Xử lý văn bản nhà nước qua NHD Harness

Skill này là **quy trình bắt buộc**, không phải gợi ý văn phong. Mọi model dùng NHD Harness phải đi đúng thứ tự dưới đây; không được nhảy thẳng tới "viết văn bản". Lý do: model tự viết thì sai thể thức (vị trí, cỡ chữ, gạch dưới, giãn dòng) và bịa trích dẫn; harness có công cụ đo thật (PDF geometry, gate) nên kết quả phải được **đo**, không được **tự khẳng định**.

Kết hợp với:
- `viet-admin-format-checker` — bộ quy tắc NĐ 30 chuẩn (canonical formatter, bắt buộc).
- `vietnam-admin-documents` — văn phong hành chính.
- `office-legal-reference-pack` — tra cứu văn bản pháp luật.

## Nguyên tắc cứng

1. **Không bịa**: số, ký hiệu, ngày ban hành, tên đơn vị, người ký, hạn nội bộ, danh sách → để `....................` nếu người dùng chưa cung cấp. Báo cáo cuối liệt kê mọi placeholder còn lại.
2. **Trích dẫn pháp lý** (Luật, Nghị định, Quyết định, Điều/khoản) chỉ dùng khi có trong văn bản gốc hoặc đã kiểm tra nguồn chính thức (vbpl.vn, congbao.chinhphu.vn, thuvienphapluat.vn). Cái chưa kiểm tra → ghi rõ "chưa đối chiếu nguồn chính thức" trong báo cáo.
3. **Không ký, không ban hành**. Đầu ra luôn là DỰ THẢO; receipt gate có `readyToSign:false` cho tới khi con người duyệt.
4. **Không ghi đè**: mỗi lần sửa tạo file version mới (`_v2`, `_v3`...).
5. Mọi thao tác file/lệnh đi qua harness (`terminal_preview` → `terminal_execute`, `fs_preview_write` → `fs_apply_write`), để có audit trail.

## Cấu trúc thư mục dự án

```
<dự án>/
  01_goc/        văn bản đến (giải nén zip, giữ nguyên)
  02_ra_soat/    BAO_CAO_RA_SOAT_<số>.md  (theo references/review-report-template.md)
  03_du_thao/    spec JSON + DOCX + PDF các version
  04_phat_hanh/  chỉ file do office_admin_release_apply ghi ra
```

## Quy trình (map với các phase của admin-document-orchestrator)

### 1. intake
- Giải nén vào `01_goc` (thư mục mới, rỗng). Đọc từng PDF bằng `pdf_document` (text + render trang để xem dấu, chữ ký, bảng).
- Xác định: cơ quan ban hành, số/ký hiệu, ngày, trích yếu, văn bản cấp trên được viện dẫn (thường đính kèm cùng zip), nơi nhận, thời hạn.

### 2. legal_resolve + review
- Lập bảng so sánh nội dung văn bản đến với văn bản cấp trên: từng yêu cầu → Bộ nói gì → Sở/UBND nói gì → đánh giá (Khớp / Thiếu / Khác / Vượt thẩm quyền).
- Rà soát câu chữ, chính tả, thuật ngữ; rà soát thể thức theo NĐ 30 (`office_admin_nd30_audit` nếu có DOCX; với PDF thì đối chiếu trực quan).
- Ghi `02_ra_soat/BAO_CAO_RA_SOAT_*.md` theo mẫu A/B/C/D trong `references/review-report-template.md`.

### 3. Hỏi vai trò đơn vị nhận (BẮT BUỘC hỏi nếu chưa rõ)
Ví dụ: "UBND xã/phường nhận", "Phòng chuyên môn cấp xã", "Sở ban hành cần sửa văn bản". Vai trò quyết định loại văn bản đầu ra (kế hoạch triển khai, công văn chỉ đạo, báo cáo...) và nơi nhận.

### 4. draft
- Viết **spec JSON** (xem `references/spec-schema.md`, ví dụ `examples/ke-hoach-cv1499-xa.json`) vào `03_du_thao/`.
- Mỗi nhiệm vụ trong văn bản đến phải có chỗ tương ứng trong văn bản triển khai (chủ trì, phối hợp, thời hạn). Hạn nội bộ phải sớm hơn hạn cấp trên.
- Dựng DOCX:
  ```
  terminal_preview: python -I <skill>/scripts/build_admin_docx.py <spec.json> <03_du_thao/..._v1.docx>
  terminal_execute: với token vừa nhận
  ```
  Script từ chối ghi đè và in receipt JSON (sha256, số placeholder).

### 5. Xuất PDF
- Ưu tiên `office_preview_export_pdf` → `office_apply_export_pdf`.
- Nếu Office Companion không có: LibreOffice qua harness terminal
  `soffice.com -env:UserInstallation=file:///<profile-tạm> --headless --convert-to pdf:writer_pdf_Export --outdir <03_du_thao> <file.docx>`.

### 6. Release gate (5 bước, không được bỏ bước)
1. `office_admin_release_prepare` (docx + pdf + đích `04_phat_hanh/...`) → nhận reviewId, số trang, lỗi geometry.
   Nếu có lỗi → sửa **spec hoặc builder**, dựng version mới, quay lại bước 5.
2. `office_admin_release_view_page` cho **từng trang**. Nhìn thật: quốc hiệu một dòng, gạch dưới đúng vị trí, không chữ tràn, số trang từ trang 2, khối ký không bị tách trang.
3. `office_admin_release_review` với nhận xét trung thực (ghi cả các điểm chưa đạt/placeholder).
4. `office_admin_release_status` op=preview → token.
5. `office_admin_release_apply` với token → file trong `04_phat_hanh` + receipt.

Các lỗi đã gặp và cách sửa: `references/gate-lessons.md`.

### 7. human_review
Báo cáo cho người dùng: đường dẫn bản phát hành + receipt, danh sách placeholder còn lại, trích dẫn chưa đối chiếu, các điểm khác biệt với văn bản cấp trên cần xin ý kiến. Không tuyên bố "sẵn sàng ký".

## Giới hạn đã biết
- Gate chỉ nhận diện tên cơ quan bắt đầu bằng "ỦY BAN NHÂN DÂN", "HỘI ĐỒNG NHÂN DÂN", "HỢP TÁC XÃ". Văn bản của Sở/Phòng có thể bị gate báo sai phần tên cơ quan → ghi rõ trong review, không hack cho qua.
- Builder hiện tạo khổ A4 dọc, một section, phần thân là đoạn văn (chưa hỗ trợ bảng trong thân bài).
