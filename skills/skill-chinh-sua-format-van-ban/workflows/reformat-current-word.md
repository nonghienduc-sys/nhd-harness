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
