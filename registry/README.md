# NHD Skill Registry v1 — kiểm kê có nguồn kiểm chứng

## Scope và tình trạng

- Nguồn: src/skills.ts, skills/ và registry/skill-capabilities.v1.json.
- Kiểm kê sau cài ngày 17/11/2026: 54 skill được đăng ký, 53 enabled, 1 disabled (legacy), 55 thư mục.
- Ba skill mới: anthropic-docx, anthropic-xlsx (giữ nguyên Apache 2.0 LICENSE.txt), van-ban-theo-mau.
- github-tools-pack chỉ chứa tài nguyên, không phải skill thực thi. Mốc lịch sử 52 không phải giới hạn đăng ký.
- Skill chuẩn quản lý format hành chính vẫn là viet-admin-format-checker; skill legacy vẫn disabled.

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
