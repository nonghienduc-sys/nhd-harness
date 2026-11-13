# NHD Administrative Document Regression — 6 document types

## Bộ kiểm thử

Dữ liệu giả lập **không được phát hành** cho sáu loại: **công văn, báo cáo, kế hoạch, tờ trình, quyết định, thông báo**.

- Fixture nguồn: `test/fixtures/admin-document-cases.v1.json`.
- Trình tạo DOCX test: `scripts/generate-admin-docx-fixtures.mjs`.
- Bộ đọc độc lập DOCX/XML: `test/helpers/admin-docx-inspector.mjs`.
- Test runner: `test/admin-document-pipeline.test.mjs`.
- Biên bản có SHA-256: `test-artifacts/admin-regression/test-receipt.json`.
- Sáu file `.docx` giả lập: `test-artifacts/admin-regression/01-cong-van.docx` đến `06-thong-bao.docx`.

## Kiểm tra kỹ thuật

1. Registry: 49 skill đăng ký, 48 bật; legacy off, canonical on; toàn bộ ID duy nhất.
2. Sáu nhánh lập kế hoạch: đúng tên loại, cấu trúc riêng, kích hoạt canonical, không kích hoạt legacy.
3. Sáu DOCX ZIP thực: A4; lề trên/dưới khoảng 20 mm, trái khoảng 30 mm, phải khoảng 20 mm; Times New Roman 12–14 pt theo bộ fixture; có quốc hiệu/tiêu ngữ, nội dung, nơi nhận, khối ký placeholder.
4. Sáu bài chạy **mock adapter**: gọi đúng skill, Safety trước ghi, receipt đầy đủ, dừng ở bước chờ người duyệt.
5. Các ca phủ định: lệch lề, sai phông, thiếu quốc hiệu, thiếu thành phần; legacy bật; canonical tắt; loại văn bản không hỗ trợ; nguồn chưa kiểm chứng; mẫu chuyên ngành thiếu; Safety từ chối; format sửa nội dung; structural QA lỗi; visual QA lỗi; backend mất kết nối; lỗi activate; receipt thiếu.

## Cách chạy

```powershell
cd D:\ChatGPT-Workstation-MCP
node scripts/build-admin-skill-registry.mjs --check
npm run build
node scripts/generate-admin-docx-fixtures.mjs
node --test test/admin-document-pipeline.test.mjs
node scripts/verify-admin-document-pipeline.mjs
```

Sau mỗi lần thay đổi, so sánh SHA-256 trong `test-receipt.json`, kiểm tra diff và không đánh dấu nghiệm thu nếu bất kỳ test nào thất bại.

## Giới hạn nghiệm thu

Đây là **bộ test hồi quy cấu trúc và điều phối**, không phải chứng thư toàn diện về Nghị định 30. Fixture cố ý giữ placeholder người ký, số ký hiệu, địa danh và căn cứ chưa xác minh. Chưa chạy visual QA toàn trang bằng Word Live, chưa kiểm tra chữ ký số/con dấu thật, chưa chạy hợp đồng adapter trên một văn bản nghiệp vụ có dữ liệu thực và chưa triển khai release production. Không nhầm một test mock thành thao tác thực tế.

Bộ test không chỉnh sửa `skills/office-*` và không yêu cầu xóa legacy skill.
