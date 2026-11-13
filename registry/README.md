# NHD Skill Registry v1 — kiểm kê có nguồn kiểm chứng

## Scope và tình trạng

- Nguồn: `src/skills.ts`, toàn bộ thư mục thực tế tại `skills/`, `SKILL.md` và `C:\ProgramData\ChatGPTWorkstationBridge\config.json`.
- Kiểm kê tại thời điểm tạo: **49 skill đã đăng ký**, **48 enabled**, **1 disabled** (legacy), **50 thư mục**, trong đó `github-tools-pack` chỉ có `SOURCES.md` và **không phải skill thực thi**.
- Con số **52 skill** được nêu trong lịch sử chưa khớp với runtime hiện tại (thiếu 3 mục so với 49 runtime). Không suy đoán hoặc bịa 3 ID. Tìm kiếm các skill ngoài nguồn kiểm kê hiện tại phải làm như một cuộc kiểm kê riêng.
- Canonical: `viet-admin-format-checker`, legacy disabled: `skill-chinh-sua-format-van-ban`. Đường dẫn file legacy và tài nguyên giữ nguyên.

## Schema

Mỗi `skills[]` ghi `registration`, `type`, `enabled`, `capability`, `io.inputs/outputs`, `dependencies.recommendedSkills`, `dependencies.hardRuntimeDependencies`, `backend.recommendedAdapters`, `backend.verifiedExecutable`, hash SHA-256 của `SKILL.md` và `fileCount`.

**Phân biệt quan trọng:** Capabilities/IO/backend/dependency của v1 là *phân loại đề xuất dựa trên mô tả skill*, **chưa phải chứng nhận mọi adapter hoạt động**. `hardRuntimeDependencies=[]` nghĩa là chưa xác minh, không phải không có dependency.

Bản registry không sửa file nào trong `skills/office-*` hay thay đổi tên skill. Alias legacy chỉ là chính sách tiêu thụ registry; runtime chính thức vẫn kiểm tra `enabled=false` và sẽ từ chối kích hoạt legacy.

## Tạo lại và kiểm tra

Chạy trong `D:\ChatGPT-Workstation-MCP`:

```powershell
node scripts/build-admin-skill-registry.mjs
node scripts/build-admin-skill-registry.mjs --check
```

Lệnh `--check` không ghi file, kiểm tra byte-for-byte rằng registry còn đúng với inventory hiện có. Nếu trạng thái skill thay đổi, tạo lại registry và nghiệm thu diff trước khi dùng.

Các bước tiếp theo sử dụng ID trong registry, không dựa trên tên hiển thị vì hai skill có cùng nhãn tiếng Việt.
