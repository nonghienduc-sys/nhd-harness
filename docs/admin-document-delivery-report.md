# NHD Admin Document Pipeline — Delivery & Audit Report

Ngày kiểm kê: 04/11/2026. Root: `D:\ChatGPT-Workstation-MCP`.

**Trạng thái:** Registry + mã điều phối + CLI + 6 DOCX fixture + 30 test đã tạo, build thành công. Chưa triển khai release production hoặc thực thi Word Live trên văn bản thật.

## Bước 2 — Skill Registry

| File (tương đối từ root) | SHA-256 |
|---|---|
| `registry/skill-capabilities.v1.json` | `a936d335a8d64527b2772fe921a7754144d78b0a0d9d7313ff03b84d2b4c3654` |
| `registry/README.md` | `dec5bb40dcfa6c87600a25de6773616da708c224ebd088542b791ffb3005431e` |
| `scripts/build-admin-skill-registry.mjs` | `d817266911f02d622a1e938770cb4f7c49313107fe9fc9440e0ee71d18f7c57a` |

## Bước 3 — Orchestration

| File (tương đối từ root) | SHA-256 |
|---|---|
| `src/admin-document-orchestrator.ts` | `bae3d8a78a222059192e79f7ca56ba7a6f93cc63702558e62c22e96dfe4e947e` |
| `docs/admin-document-pipeline.md` | `706dae41743b5c1db2be06b9eead7321e5a85f5594fccb4dbb1598a9a70801ca` |
| `scripts/admin-document-plan.mjs` | `d2836b635cc2fd4842439551400fce7f56e8a7c3a2c960609eaf00b6368dbe7e` |

## Bước 4 — Regression

| File (tương đối từ root) | SHA-256 |
|---|---|
| `test/fixtures/admin-document-cases.v1.json` | `65a088a079af13bec86d0b77c6fe6f105b4dfa64b09fbb40d76b62b6c2f86a49` |
| `scripts/generate-admin-docx-fixtures.mjs` | `464521e9dffd4afd650390a97e3a5f1a8f7da7dafb4f3ca8ad9a865a5e95da3c` |
| `test/helpers/admin-docx-inspector.mjs` | `4056640ccbd3d416efe8c36aca0920b8be3868c0a458785258cc3e43bdc75f20` |
| `test/admin-document-pipeline.test.mjs` | `dc41a5ca25714a9a6e5c771c7de4dc1b903a6234c424cbeec9f1f4a46d7ca57a` |
| `docs/admin-document-regression.md` | `f9d5350bd5bc9034e4f72a062682489bc6f20b2e36cdfb784d6dd6763964cba7` |
| `scripts/verify-admin-document-pipeline.mjs` | `301aeeb4dd25ffaaf42c8084ef94a80e95758acbd5b093e4d010672c728281d9` |
| `test-artifacts/admin-regression/fixture-manifest.json` | `0f6d02bc982bd452faac615bf07f07ce587bf6ef70f7c7a3ad38176486882872` |
| `test-artifacts/admin-regression/test-receipt.json` | `50de0a9a509e15a7912730eeb83783a7257ee8dd17f2466360b95f806b58296e` |

## Sáu DOCX fixture giả lập — tuyệt đối không phát hành

| Loại | File | SHA-256 |
|---|---|---|
| `cong_van` | `test-artifacts/admin-regression/01-cong-van.docx` | `b89259518fc1583082985cf8329f930615267a210d15567257b1ecdc0f3fe5c7` |
| `bao_cao` | `test-artifacts/admin-regression/02-bao-cao.docx` | `894b672313a6ce78a46dc3da62a63a17947585dd6896ffe04ec497709a87a236` |
| `ke_hoach` | `test-artifacts/admin-regression/03-ke-hoach.docx` | `70c2dfc6f58dc1c3507465c224c9df08c6d6a6f1bc48ebe8fb7173dc20219ec9` |
| `to_trinh` | `test-artifacts/admin-regression/04-to-trinh.docx` | `5ce46c80939c5a1631254076bb7040f211b1139cb4ff5e9e60923b95547f5ff9` |
| `quyet_dinh` | `test-artifacts/admin-regression/05-quyet-dinh.docx` | `358d1d305d7d55242a2d339b8dbbc2b3558cb4d2081496397ecdd47fadf30eec` |
| `thong_bao` | `test-artifacts/admin-regression/06-thong-bao.docx` | `f94d7e5b7802da9ce0fc8d5350c92a19a219a5ebc2e30779ce6a8fc49a094905` |

## Kết quả nghiệm thu

- `npm run build`: PASS.
- Registry deterministic `--check`: PASS.
- `node --test test/admin-document-pipeline.test.mjs`: **30/30 PASS**, 0 FAIL.
- MCP NHD `skills_activate` read-only: `viet-admin-format-checker`, `vietnam-admin-documents`, `viet-admin-docx-template-builder`, `office-workflow-qa` đều trả enabled. Đây không phải chạy Word thực.
- 49 skill đăng ký, 48 enabled, 50 thư mục; `github-tools-pack` resource-only. 52 lịch sử chưa đối soát.
- Legacy có 11 file vẫn tồn tại và disabled. Không có thao tác ghi nào đến `skills/office-*`.

## Giới hạn và công việc chưa triển khai

1. Orchestrator có `activateSkill`, `authorizeWrite`, `executeStep` để host cắm adapter NHD thực; chưa chạy end-to-end DOCX thật.
2. Test fixtures chỉ kiểm tra cấu trúc; chưa có kiểm định pháp lý/visual QA Word-PDF toàn trang.
3. Production immutable `v0.24.7` vẫn chứa artifact router cũ; source router và module mới đã build nhưng **chưa promote release**. Skill disable ở live vẫn hiệu lực.
4. Mới chạy targeted regression và build, chưa chạy toàn bộ repo tests.

## Tái nghiệm thu độc lập

```powershell
cd D:\ChatGPT-Workstation-MCP
node scripts/build-admin-skill-registry.mjs --check
npm run build
node --test test/admin-document-pipeline.test.mjs
node scripts/verify-admin-document-pipeline.mjs
```

Không tự ký, đóng dấu, cấp số, gửi Outlook hoặc phát hành văn bản.
