# Workflow: resolve văn bản chuyên ngành

## 1. Detect route
Đọc `registry/specialized-router.yaml`. Một tiêu đề chung như "Kế hoạch", "Báo cáo", "Thuyết minh" không đủ để chọn NĐ30.

## 2. Load source registry
Đọc `sources/source-registry.yaml`. Nếu nguồn có `partially_effective`, `historical`, `current_as_verified` hoặc guard riêng thì thực hiện guard trước.

## 3. Load domain pack
Ưu tiên một trong:
- Khởi nghiệp Bắc Ninh 2026.
- Đăng ký HTX.
- MTQG 2026-2030.
- Hỗ trợ phát triển sản xuất nông nghiệp.
- Biểu mẫu đầu tư.

## 4. Resolve exact form
Nếu pack yêu cầu exact template:
- tìm đúng phụ lục/mẫu chính thức;
- xác minh năm/phiên bản;
- xác minh sửa đổi, bãi bỏ;
- không tái sử dụng mẫu năm trước theo suy đoán.

## 5. Build Resolved Document Spec
Mỗi component ghi:
- source_id;
- priority P1-P7;
- strength;
- value;
- override status.

## 6. Only then use NĐ30
NĐ30 chỉ lấp khoảng trống khi:
- pack chuyên ngành không quy định;
- không có xung đột;
- phạm vi áp dụng phù hợp.

## 7. Validate and visual QA
Chạy source-freshness, template, structural và visual QA trước khi hoàn thành.
