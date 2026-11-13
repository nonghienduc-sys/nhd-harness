# Workflow: chỉnh format file Word đang mở

1. Xác nhận Word và tài liệu đang mở bằng `office_status` / `office_live_read`.
2. Đọc đủ cấu trúc cần thiết; không thay đổi file.
3. Classify tài liệu theo `core/document-classifier.yaml`.
4. Resolve nguồn theo `core/legal-source-resolver.yaml`.
5. Nếu cần nguồn cập nhật/chuyên ngành mà chưa có: tra nguồn chính thức trước.
6. Tạo Resolved Document Spec.
7. Audit trước sửa và ghi danh sách ERROR/WARNING.
8. Dùng Office Live preview/apply cho thay đổi nhỏ hoặc Word automation an toàn cho thay đổi toàn tài liệu.
9. Giữ nội dung nguyên vẹn nếu user chỉ yêu cầu format.
10. Save.
11. Đọc lại cấu trúc sau sửa.
12. Capture cửa sổ Word hoặc export PDF để visual QA.
13. Kiểm tra trang đầu, trang có bảng/chuyển trang và trang cuối/chữ ký.
14. Nếu có lỗi: sửa và QA lại.
15. Chỉ kết luận hoàn thành khi ERROR bắt buộc = 0 và visual QA đạt.

## Anti-patterns

- Không áp NĐ30 ngay khi nhìn thấy Quốc hiệu.
- Không coi tiêu đề "Kế hoạch" là đủ để kết luận đây là Kế hoạch hành chính chung.
- Không lấy một file mẫu cũ/không rõ nguồn làm quy định.
- Không sửa nội dung để làm vừa layout nếu user chưa yêu cầu.
- Không báo xong trước khi nhìn lại kết quả.


## Gate bổ sung: Justify và hình học Shape Line (NĐ30 hoặc giao diện hành chính người dùng yêu cầu)

- Trước khi sửa phải snapshot file thật, số trang, SHA-256, và ghi nhận thay đổi chưa lưu trong Word Live. Không ghi đè bản gốc khi chưa có QA.
- Áp dụng Justify cho từng đoạn lời văn, Times New Roman 13–14pt, đầu dòng 1 hoặc 1,27cm, sau đoạn >=6pt, khoảng cách dòng 1–1,5. Không đổi alignment của quốc hiệu, tiêu ngữ, tên loại, tiêu đề, nơi nhận, chữ ký.
- Header là table 2 cột: nếu có phantom cells phải kiểm tra không có dữ liệu chữ, sao lưu và xử lý trên bản ứng viên. Word COM tạo Shape neo trong cell có thể làm phát sinh cột ẩn; không coi nó là lỗi đã xử lý khi chỉ sửa 1 lần.
- Shape Line phải là native DrawingML wps:wsp + a:prstGeom line, không dùng PNG/JPEG. Đường kẻ tên cơ quan bằng 1/3–1/2 độ dài dòng chữ; tiêu ngữ bằng độ dài thật của chữ.
- Không đặt line theo tọa độ suy đoán từ cạnh bảng. Đặt theo biên glyph đo từ PDF của DOCX, dùng Shape neo ngoài bảng hoặc cập nhật OOXML an toàn, rồi xuất PDF mới.
- Bắt buộc chạy office_admin_nd30_audit để kiểm tra cấu trúc và:
  python scripts/qa_admin_pdf_geometry.py --pdf <path-to-rendered-pdf> --mode verify --json <receipt.json>
- Nếu PDF geometry lỗi, header xuống dòng, paragraph không Justify hoặc Word tự thêm ghost column: FAIL CLOSED; không phát hành, không ghi đè file thật.
- Chỉ promote file sau khi kiểm tra đủ trang đầu, trang chữ ký, đối chiếu text và các vùng bôi vàng giữ nguyên.

## Cổng phát hành quản lý sau Visual QA

Sau bước 15, khi cần bàn giao bản DOCX hoàn thiện:
- office_admin_release_prepare → trả trạng thái visual_review_required cùng đường dẫn PNG mọi trang.
- Dùng office_admin_release_view_page lấy PNG từng trang để thật sự kiểm tra; chỉ office_admin_release_review pass khi mọi trang đã xem.
- office_admin_release_status op=preview + office_admin_release_apply tạo mới file thành phẩm và receipt có các SHA-256.
- Văn bản đang mở chưa lưu, PDF khác nội dung DOCX, tràn trang hoặc receipt sai hash đều phải chặn; không gửi link/nói 'đã hoàn thành'.
- Công cụ định dạng trực tiếp chỉ trả trạng thái bản nháp, không được tự nâng thành 'đã phát hành'.
