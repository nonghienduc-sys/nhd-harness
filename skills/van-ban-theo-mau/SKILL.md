---
name: van-ban-theo-mau
description: "Quy trình bắt buộc tạo văn bản Word dựa trên tệp mẫu gốc, giữ thể thức và kiểm soát bố cục, bảng, căn cứ, số liệu."
---

# Văn bản Word theo mẫu

1. Trước khi tạo, lập bảng ánh xạ: tệp sản phẩm ↔ tệp mẫu dùng làm khung.
2. Tạo bằng python -I "D:\NHD Nghiem Thu\dung_tu_mau.py" "<mẫu>" "<ra.docx>" --thay "<thay.json>" (thêm --a4 nếu cần). Không tạo Word từ trang trắng, không dựng lại từ bản cũ của sản phẩm.
3. Điền đúng từng cột theo cấu trúc ô gộp thực tế của mẫu, kiểm tra đơn vị, số lượng, đơn giá và thành tiền. Xóa sạch số liệu, họ tên, tên thôn và thông tin riêng của mẫu. Không lược bỏ căn cứ có trong mẫu.
4. Kiểm tra bằng python -I "D:\NHD Nghiem Thu\kiem_format.py" "<ra.docx>" --mau "<mẫu>"; yêu cầu TỔNG: ĐẠT.
5. Chạy validator gốc Anthropic qua wrapper hỗ trợ Python -I: python -I "D:\ChatGPT-Workstation-MCP\skills\van-ban-theo-mau\validate_docx.py" "<ra.docx>"; wrapper gọi skills\anthropic-docx\scripts\office\validate.py không chỉnh sửa; yêu cầu All validations PASSED!.
6. Tự soát và ghi receipt bao gồm SHA-256, sao lưu nếu sửa tệp có sẵn, lệnh kiểm tra và kết quả.

Hướng dẫn: D:\NHD Nghiem Thu\HUONG_DAN_FORMAT.md.

Không thay thế viet-admin-format-checker (Nghị định 30/2020/NĐ-CP). Khi có mẫu của văn bản hành chính phải dùng đồng thời cả hai skill.
