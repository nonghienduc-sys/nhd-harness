# SBCE P0–P6 — trạng thái triển khai và bằng chứng
Ngày rà soát: 2026-11-12. Thiết kế nguồn: `docs/STRONG-BRAIN-CHEAP-EXECUTOR-2026-11-12.md`.

## Trạng thái phát hành
- Production: `v0.24.19-9265e8e2da17`, MCP/Cloudflare vẫn hoạt động.
- Candidate (source): `v0.24.20-3c6ff41d3fc0`.
- Source tests: **622/622 PASS**; atomic staging smoke **18/18 PASS**; atomic verify PASS.
- MCP candidate contract: off, shadow, worker-kill test PASS; legacy MCP tool names preserved; unauthorized remote /mcp = HTTP 401.
- No HHTECH API key or live billing catalog exists yet in SBCE Vault/runtime. No paid SBCE inference performed.

## Ma trận P0–P6 (không đánh đồng "đã viết code" với "đã nghiệm thu")
| Giai đoạn | Đã có | Thiếu để nghiệm thu thiết kế |
|---|---|---|
| P0 | MCP contract + baseline code regression, Redaction Guard, 40 work orders Golden Set, offline scorer | Golden Set canned references/real Brain baseline; baseline tokens/time không thể tự suy đoán |
| P1 | Worker riêng, HHTECH OpenAI/Anthropic adapter, DPAPI Vault, per-call Budget Guard, circuit breaker 3 lỗi/5 phút, dashboard, disabled catalog | Chưa có owner-entered key hoặc account billing confirmation; chưa test API live theo 2 provider |
| P2 | 3 MCP facade, SQLite jobs, shadow, static patch integrity anti locked/test tamper, bounded review | Machine L0 isolated worktree/build/test chưa có; 50% Golden Set code chưa được chứng minh |
| P3 | Retry/Fixer feedback, T1–T3 cascade, independent cross-family L1, approved-only Failure Library, source guard | Chưa đạt chỉ số sửa code trên việc thực; chưa có on-mode apply có xác nhận; không chạy generated code trên host |
| P4 | Context Pack ≤6k, verified Project RAG and file evidence via MCP, source locator required for research, role writer/coder/researcher | Role planner/summarizer đầy đủ, ND30/Office QA pipeline in SBCE, cache-hit/Brain-token KPI chưa đo |
| P5 | Model Router with bounded exploration ≤10%, stats chỉ khi Brain accept, failure fingerprints approved-only, offline eval report | ≥2 tuần telemetry thực, 20% savings, judge calibration weekly and self-evolution candidate chưa chứng minh |
| P6 | Full regression, independent staging, off/shadow and worker-crash MCP survival checks, Lite audit | 7 ngày on-mode liên tục, real load p95, rollback rehearsal on this candidate, final Lite installer verification |

## Quy tắc bảo toàn
- Mọi model đầu ra là không tin cậy. `sbce-patch-gate.ts` chỉ là kiểm tra tĩnh, **không tương đương build/test trong Windows Sandbox**.
- `sbce-eval.mjs` không tự tính pass hoặc savings khi thiếu proof. Kết quả hiện tại: 0/40 evidence.
- Trần đã chốt giữ nguyên 20.000đ/job và 300.000đ/ngày (múi giờ Việt Nam), không bật provider/chi tiền từ thao tác staging.
- Không chạm transport ChatGPT MCP, OAuth, tunnel. SBCE mặc định `off`, không tự cutover/restart.
- Q1–Q6 trong tài liệu Claude giữ nguyên. Quyền áp dụng code vào file thật vẫn qua cổng xác nhận của NHD và Brain.

## Ghi chú kỹ thuật
- Context Pack: `src/sbce-context.ts`, `src/mcp-registries/delegation-tools.ts`, file/RAG locators, nguồn không tin cậy, skip secret/redacted.
- Static patch guard: `src/sbce-patch-gate.ts`; chống traversal, protected path, test skip và binary.
- Router/Fixer/approved feedback: `src/sbce-router.ts`, `src/sbce-failure-library.ts`, `src/sbce-store.ts`, `src/sbce-runner.ts`.
- Circuit: `src/sbce-circuit.ts`; breaker ở provider. 
- Offline benchmark: `node scripts/sbce-eval.mjs` → `temp/sbce-eval-offline-report.json`; **không** đồng nghĩa verified real baseline.

## Phần bị chặn bởi bằng chứng ngoài mã nguồn
1. Khóa HHTECH chưa được nhập vào SBCE Vault; catalog runtime chưa có tài liệu đối soát giá theo tài khoản. Không suy đoán credential hoặc tự kích hoạt tính phí.
2. Windows Sandbox Isolated Agent có cấu hình nhưng chưa online; không chạy các patch do LLM sinh trên host.
3. KPI nhiều ngày/tuần (P5/P6) cần dữ liệu sau khi vận hành. Không thể xác nhận bằng test giả.
4. Cutover production cần xác nhận riêng; không nằm trong quyền của tác vụ lập trình này.


## P6 — Gói cài đặt Lite v0.24.20 (đã xây dựng)
- File phiên bản: `D:\ChatGPT-Workstation-MCP\release-lite\NHD-Harness-Lite-0.24.20.exe` — **179.198.679 bytes**.
- SHA-256: `b0851316e6e395c50b9a7c465d651107312bfd899b3c46dd8122d8cafb542270`.
- Checksum: `release-lite/NHD-Harness-Lite-0.24.20.SHA256SUMS.txt`.
- `node scripts/lite-package-audit.mjs --verify` PASS: payload Verified, no leaked private runtime files, no redaction marker in packaged code.
- Không cập nhật installer tên ổn định `NHD-Harness-Lite-Setup.exe`, không phát hành GitHub, và **không cài** bản mới; đây là artifact để nghiệm thu.
- Tiêu chí 7 ngày on-mode và thực hiện rollback rehearsal vẫn chưa có dữ liệu, nên P6 **chưa thể đánh dấu nghiệm thu toàn phần**.

## P1 — Trạng thái khóa và model catalog trên máy
- Kiểm tra read-only: `C:\ProgramData\ChatGPTWorkstationBridge\vault\sbce-hhtech.bin` chưa tồn tại.
- `C:\ProgramData\ChatGPTWorkstationBridge\sbce-model-catalog.json` chưa tồn tại.
- Đã dò các tab Cốc Cốc đang mở; không có tab HHTECH portal, không có căn cứ truy cập bảng giá account-specific từ phiên đăng nhập.
- Không suy đoán API key, không gọi thử API trả phí, và không tự khẳng định mục tiêu tiết kiệm token đạt.
