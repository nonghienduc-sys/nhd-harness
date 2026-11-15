# Biên bản nghiệm thu ứng viên NHD Harness Chế độ 2 — 14/11/2026

**Phạm vi:** Chế độ 2 = GPT-6 (Brain) gọi NHD Harness (MCP) trực tiếp, không qua model nhỏ; chuyển chế độ từ hội thoại qua `harness_mode`. Thử nghiệm trên mã nguồn và bản ứng viên, **chưa cutover production**.

## Kết quả kiểm thử

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| Khôi phục tệp `src/server.ts` bị cắt cụt | PASS | `temp/mode2-source-patch-receipt-20261114.json`, SHA-256 mới `9528b10343851921b4687a98c37da9c055946f076cb4e4cfb61173b7d71b6a58` |
| Build TypeScript `npm run build` | PASS | Mã thoát 0 |
| Tạo tài liệu kiến trúc `npm run docs:architecture` | PASS | 159 công cụ trong catalog |
| Bộ kiểm thử `npm test` | PASS | 756/756 bài; thất bại 0, bỏ qua 0 |
| Tích hợp 2 phiên MCP mô phỏng remote/local | PASS | `test/harness-mode-integration.test.mjs`; mode lưu chung, `select` cần task đang chạy + ủy quyền + confirmed, `fs_read` bị khóa ở chế độ 1/3, hoạt động ở chế độ 2 |
| Kiểm tra định dạng thay đổi `git diff --check` | PASS | Mã thoát 0 |
| Stage ứng viên bất biến | PASS | `v0.24.34-68a541d05d34` |
| Smoke ứng viên ở cổng 39200 | PASS | 17/17 khẳng định đều đúng; `deploy-backups/atomic-release-v0.24.34-68a541d05d34-smoke.json` |
| Atomic verify và ghi nhận biên nhận | PASS | `candidate.verifiedAt=2026-11-13T20:36:52.056Z` |
| Cutover production | CHƯA THỰC HIỆN | Production vẫn là `v0.24.33-a8f6072132ab`, `currentMatchesActive=true` |

## Các điểm chưa nghiệm thu ở production

1. Kết nối remote/local của **bản production mới** chưa được kiểm tra sau cutover; bài test remote/local hiện sử dụng hai phiên MCP in-memory cùng runtime, còn smoke trên bản ứng viên kiểm tra giao diện HTTP, phiên bản và xác thực, không thay thế nghiệm thu chuyển chế độ trực tiếp qua hai kết nối thật.
2. Worktree chứa nhiều thay đổi SBCE/dashboard chưa commit từ trước; bản ứng viên được tạo từ toàn bộ `dist` hiện tại, **không chỉ các sửa đổi Chế độ 2**. Cần duyệt phạm vi thay đổi trước khi phát hành.
3. Một phép thử dùng SQLite tạm phát cảnh báo cleanup `EPERM` khi dọn thư mục Temp trên Windows; bài thử chức năng vẫn PASS. Đây không phải lỗi xác minh mode nhưng cần dọn tài nguyên thử nghiệm khi không còn sử dụng.

## Phán quyết

**NGHIỆM THU ỨNG VIÊN: ĐẠT (staging verified).**

**NGHIỆM THU PRODUCTION: CHƯA.** Không được báo đã nâng cấp bản chính. Việc cutover/restart phải được người dùng phê duyệt riêng theo quy trình trong `CLAUDE.md`; sau đó kiểm tra `runtime_identity`, health, mode qua hai kết nối MCP thật, canary file preview/apply/readback và rollback readiness.

**Rollback hiện hữu:** `v0.24.33-29850dcff034` (previous release theo release-state); production đang hoạt động là `v0.24.33-a8f6072132ab`.
