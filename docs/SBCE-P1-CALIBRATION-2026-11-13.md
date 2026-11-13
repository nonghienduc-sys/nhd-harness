# SBCE P1 — hiệu chuẩn HHTECH (2026-11-13, giờ VN)

## Trạng thái
- Production: `v0.24.24-3096faaf1635` (generation 49). Cutover đạt 11/11 assertion; supervisor và cloudflared giữ nguyên PID; remote `/mcp` không xác thực trả 401.
- Mode SBCE = `shadow`, đọc từ `C:\ProgramData\ChatGPTWorkstationBridge\sbce-mode.json`. Muốn tắt: đổi thành `{"mode":"off"}` rồi restart backend.
- Khóa HHTECH do chủ nhập qua `sbce.html` và đã lưu bằng DPAPI (`vaultConfigured: true`).
- Catalog runtime có 6 model, **tất cả đang tắt**. Chưa có `priceAudit`.

## Model khóa truy cập được
`GET /v1/models` trả 116 model. Cả 6 model trong catalog đều có trong danh sách.

## Probe (prompt cố định, tối đa 16 token output) — nhật ký: `sbce-probes.jsonl`
| catalogId | model | Kết quả | in/out token | Độ trễ | UTC |
|---|---|---|---|---|---|
| t1-deepseek | deepseek-v4-flash | OK | 44/9 | 2,3 s | 21:37:16 |
| t1-qwen | qwen3-coder-plus | **HTTP 502** (2 lần) | – | – | 21:37:19, 21:37:43 |
| t1-haiku | claude-haiku-4.5 | OK | 36/6 | 6,2 s | 21:37:19 |
| t2-deepseek | deepseek-v4-pro | OK | 18/1 | 3,6 s | 21:37:25 |
| t2-gpt | gpt-5.6-luna | OK | **1**/5 (usage input nghi bất thường) | 6,9 s | 21:37:29 |
| t3-sonnet | claude-sonnet-5 | OK | 33/4 | 3,8 s | 21:37:36 |

## Còn thiếu để nghiệm thu P1
1. Đối soát lượng credit đã trừ cho từng lần gọi trên trang nhật ký sử dụng của portal HHTECH, sau đó ghi `priceAudit` (source `account_usage`) và chủ duyệt.
2. Qwen3-coder-plus đang trả 502 phía gateway, nên giữ ở trạng thái tắt cho tới khi probe thành công.
3. Usage input của gpt-5.6-luna trông bất thường. Cần đối chiếu với nhật ký trên portal trước khi tin số token dùng để tính chi phí.
4. Chạy job shadow thật đầu tiên qua MCP sau khi đã bật ít nhất 1 model có hiệu chuẩn.

## Đối soát portal HHTECH (đọc lúc 2026-11-13, chế độ nguồn Claude "Giá Gộp ×1")
Giá gộp lấy từ trang `#/models`, đơn vị credit/1M token (1 credit = 1đ). Credit trừ lấy từ nhật ký trên trang overview.
| catalogId | Giá gộp portal | vndPerM trong catalog | Credit trừ khi probe (token in+out) | Nhận xét |
|---|---|---|---|---|
| t1-deepseek | 350 | 350 | **10** (53) | Giá khớp. Nhưng 10 credit cho 53 token cho thấy có **phí tối thiểu mỗi request** |
| t1-qwen | 400 | 400 | – (502) | Giữ ở trạng thái tắt |
| t1-haiku | 400 | 400 | 0,02 (42) | Khớp với giá gộp, không thấy phí tối thiểu |
| t2-deepseek | 600 | 600 | 1 (19) | Giá khớp, phí tối thiểu khoảng 1 credit |
| t2-gpt | **600** | **500** | 1 (6) | Catalog đang **đặt giá thấp hơn thực tế**, cần nâng lên 600 |
| t3-sonnet | 1.200 | 1.200 | 1 (37) | Giá khớp, phí tối thiểu khoảng 1 credit |

Đề xuất `priceAudit` (chờ chủ duyệt): `source: "account_usage"`, `maxVndPerM` = giá gộp portal, `sampleCount: 1`.
Lưu ý: guard chi phí hiện chỉ tính theo token và chưa tính phí tối thiểu mỗi request. Với job lớn, chênh lệch này không đáng kể.

## Chủ duyệt và job shadow đầu tiên (2026-11-13 04:44 giờ VN)
- Chủ đã duyệt `priceAudit` cho 5 model: t1-deepseek 350, t1-haiku 400, t2-deepseek 600, t2-gpt 600, t3-sonnet 1.200. Catalog runtime đã được cập nhật; bản gốc lưu ở `sbce-model-catalog.json.pre-priceaudit-20261113.bak`. Worker đọc catalog trực tiếp nên không cần restart: `modelCount: 5`, không có cảnh báo catalog.
- Job `job-64b4e190-a955-4fa8-814e-fdc5759ea2e5` (doc_write, sandbox_only) chạy 13 giây và qua đủ hai cổng: L0 artifact_shape và L1 cross_family_judge. Brain kiểm tra bản nháp (217 từ, đủ 4 bước) và đã **accept**.

### Phát hiện: chi phí SBCE ghi nhận thấp hơn thực tế khoảng 5 lần
| Request | Token theo portal (in/out) | Credit thực trừ | Token SBCE ghi nhận |
|---|---|---|---|
| deepseek-v4-flash (người viết) | 291/1.805 | **10** | 291/1.805 |
| claude-haiku-4.5 (giám khảo) | 910/204 | 0,45 | **4**/204 |
| Tổng | | **10,45** (ví giảm 89.784,32 → 89.773,88) | SBCE ghi 2đ |

Hai nguyên nhân:
1. deepseek-v4-flash có **phí tối thiểu mỗi request khoảng 10 credit**. 2.096 token đáng lẽ chỉ tốn khoảng 0,73 credit.
2. Với giao thức anthropic, gateway trả về `input_tokens` không gồm phần token cache (`cache_creation`/`cache_read`), nên SBCE chỉ đếm được 4 trên 910 token input.

**Đề xuất sửa (P1b):**
- Thêm trường `minVndPerCall` vào catalog và `priceAudit`.
- Tính phí mỗi request theo công thức `max(token×giá, minVndPerCall)`.
- Cộng `cache_creation_input_tokens` và `cache_read_input_tokens` vào số token input của anthropic.
- Giữ dự trữ ngân sách trước khi gọi model.

## P1b — sửa cách tính chi phí (bản 0.24.25, ĐÃ CUTOVER)
- `sbce-budget.ts`:
  - Chi phí thực mỗi lần gọi = `ceil(max(token × giá, minVndPerCall))`.
  - Phần đặt trước ngân sách tối thiểu bằng `minVndPerCall`.
  - Thêm `billableInputTokens`: token input dùng để tính tiền không thấp hơn số byte UTF-8 của prompt chia 4, phòng khi gateway báo thiếu.
- `sbce-provider.ts`: với giao thức anthropic, input = `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`. Giao thức openai giữ nguyên `prompt_tokens`, không cộng trùng.
- `sbce-catalog.ts`: thêm trường tùy chọn `minVndPerCall` ở cấp model và trong `priceAudit`; khi cả hai cùng có thì lấy giá trị lớn hơn.
- `sbce-core.ts`: thêm `minVndPerCall?` vào kiểu `SbceModel`.
- Test:
  - 4 test P1b mới trong `test/sbce-p1-calibration.test.mjs`.
  - Toàn bộ bộ test đạt 637/638. Test còn lại là `sbce-worker.test.mjs`: nó cần cổng 39300, cổng này đang bị worker production chiếm (PID 27008), lỗi do môi trường.
- Bản phát hành `v0.24.25-a63b73cea784`: smoke đạt 11/11 và đã verify.
- Catalog runtime đã thêm `minVndPerCall` ở cấp model: flash 10, pro 1, luna 1, sonnet 1, haiku 0. Bản sao trước khi sửa: `.pre-p1b-floor-20261113.bak`.
  - Không đặt trong `priceAudit` vì schema của bản 0.24.24 kiểm chặt và sẽ từ chối toàn bộ catalog.
  - Đã kiểm: catalog hợp lệ với cả 0.24.24 và 0.24.25, đều bật 5 model.
- Tính lại job đầu tiên theo quy tắc mới: flash 10 + haiku khoảng 1 = **khoảng 11đ**. Ví thực trừ 10,45. Ước tính hơi cao hơn thực tế, tức là an toàn.
- **Cutover lúc 2026-11-13 04:5x giờ VN:** production chạy `v0.24.25-a63b73cea784`, generation 50.
  - Đạt 11/11 assertion. Supervisor và cloudflared giữ nguyên PID. Bản rollback: v0.24.24.
  - SBCE online ở mode shadow, `modelCount: 5`, không có cảnh báo catalog. Remote `/mcp` không xác thực trả 401.
  - Receipt: `deploy-backups/atomic-release-v0.24.25-a63b73cea784-cutover.json`, kèm file `.log`.

## Job đối chiếu sau P1b (0.24.25) — ĐẠT
Job `job-eabd812b-2d41-4385-9a13-bda3fcbb8b37` (doc_write, sandbox_only), qua L0 và L1. Brain đã accept: bản nháp 142 từ, đủ 5 ô kiểm.
| Request | Portal in/out | Credit portal | 
|---|---|---|
| deepseek-v4-flash 04:51:52 | 292/1.599 | 10 |
| claude-haiku-4.5 04:52:08 | 742/1.630 | 0,95 |
| **Tổng** | **1.034/3.229** | **10,95** (ví giảm 89.773,88 → 89.762,93) |

SBCE ghi nhận **11đ**, tokens 1.034/3.229. Token khớp đúng với portal; chi phí cao hơn thực tế 0,05đ, đúng hướng an toàn. Trước P1b, SBCE chỉ ghi 2đ trong khi thực trừ 10,45.

**Kết luận P1:** mọi việc trong mục "Còn thiếu để nghiệm thu P1" đã xong, trừ qwen3-coder-plus vẫn tắt do lỗi 502.
- Giá đã được đối soát với portal và chủ đã duyệt.
- Đã chạy job shadow thật.
- Đã đối chiếu chi phí với ví.

Lưu ý: chi phí thật của một job nhỏ chủ yếu là phí sàn 10 credit mỗi request của deepseek-v4-flash. Router hiện chọn model theo `vndPerM` nên flash vẫn đứng đầu T1. Với job nhỏ, haiku (không có phí sàn) sẽ rẻ hơn. Có thể cân nhắc cho router tính cả phí sàn ở P2.

## Bản 0.24.26 — router tính phí sàn và các sửa lỗi vận hành (ĐÃ CUTOVER)
- `sbce-core.ts`: hàm mới `expectedCallVnd(model, estTokens)` = max(token × giá, `minVndPerCall`). `chooseVerifier` nhận thêm `estTokens` (không bắt buộc); khi có giá trị này, hàm chọn giám khảo khác họ có chi phí kỳ vọng thấp nhất trong T1 và T2.
- `sbce-router.ts`: thêm tham số `estTokens`. Router xếp ứng viên và tính điểm Thompson theo giá hiệu dụng, đã gồm phí sàn. Ví dụ: job nhỏ (~2.500 token) chọn haiku thay cho flash, vì flash có phí sàn 10. Job rất lớn vẫn chọn flash.
- `sbce-runner.ts`:
  - Ước lượng số token cho người viết và giám khảo trước mỗi lần chọn model.
  - Sửa lỗi `allow_t3=false` chặn luôn bước T1→T2: giờ chỉ chặn T3.
- `sbce-process.ts`: worker tự khởi động lại khi chết bất thường.
  - Chờ tăng dần từ 1 giây, tối đa 60 giây; tối đa 5 lần trong 10 phút.
  - Khi gọi `stop()` thì không khởi động lại.
  - Status trả thêm `restartCount` và `lastExit`.
- `sbce-worker.ts`: chấp nhận cổng từ 39300 đến 39309. Production vẫn cố định 39300; test worker dùng 39309 nên chạy được song song với worker production.
- Test: thêm `test/sbce-v02426.test.mjs` với 5 test. Toàn bộ bộ test đạt **643/643**, gồm cả `sbce-worker.test.mjs` lúc production đang chạy.
- Ước tính với job như job đối chiếu: trước là flash viết (10) + haiku chấm (~1) ≈ 11đ; nay là haiku viết (~1) + gpt-5.6-luna chấm (~1) ≈ **2đ**.
- Release `v0.24.26-dd52c45b67fe`: smoke đạt 18/18 và đã verify (`deploy-backups/atomic-release-v0.24.26-dd52c45b67fe-smoke.json`). Cutover: xem mục bên dưới.
- Bản sao trước khi sửa: các file `*.pre-0.24.26.bak` cạnh từng file đã sửa.

### Cutover 0.24.26 và job đối chiếu (2026-11-13 ~05:00 giờ VN)
- **Cutover:** chủ cho phép. Production chạy `v0.24.26-dd52c45b67fe`, generation 51.
  - Đạt 11/11 assertion. Supervisor, cloudflared và tunnel giữ nguyên; `fastState: healthy`. Bản rollback: v0.24.25.
  - Remote `/mcp` không xác thực trả 401.
  - SBCE online ở mode shadow, `modelCount: 5`, `restartCount: 0`, không có cảnh báo catalog.
  - Receipt: `deploy-backups/atomic-release-v0.24.26-dd52c45b67fe-cutover.json`, kèm file `.log`.
- **Job `job-b2658afa-c2e4-4611-b3d8-50bfecd4be97`** (doc_write, sandbox_only): router chọn haiku viết, gpt-5.6-luna chấm, đúng như thiết kế.

| Request (portal) | in/out | Credit |
|---|---|---|
| claude-haiku-4.5 (người viết) 05:01:00 | 246/270 | 0,21 |
| gpt-5.6-luna (giám khảo) 05:01:13 | 224/471 | 1 |
| **Tổng** | **470/741** | **1,21** (ví giảm 89.762,93 → 89.761,72) |

- SBCE ghi **2đ**, tokens 470/741: token khớp đúng với portal, chi phí ghi cao hơn thực tế (an toàn).
- Chi phí thực giảm từ 10,95 xuống **1,21** credit cho cùng loại job, khoảng **9 lần**.
- **Chất lượng:** Brain **reject** nội dung. Cuối bản nháp có một đoạn văn bản thừa (chỉ dẫn hệ thống bị lọt ra), nhưng L1 vẫn cho qua. **Việc cần làm tiếp:** thêm vào L0 bước kiểm tra chặn văn bản kiểu chỉ dẫn hệ thống hoặc prompt bị lọt ra trong artifact. Đồng thời theo dõi tỷ lệ chất lượng của haiku khi làm người viết so với flash.

## Bản 0.24.27 — kiểm L0 chặn văn bản chỉ dẫn bị lọt (ĐÃ CUTOVER)

- `src/sbce-runner.ts`: thêm `detectInstructionLeak()` và check `L0_no_instruction_leak`. Bản nháp chứa dấu hiệu chỉ dẫn hệ thống (`[SYSTEM INSTRUCTION…`, "system-level output rule", thẻ `<system…>`, "ignore previous instructions", "output exactly the following token") bị trả về writer kèm phản hồi; judge không bao giờ thấy bản lỗi; 2 lần lỗi cùng tầng thì lên tầng.
- Test: `test/sbce-v02427.test.mjs` (dùng đúng đoạn lọt của job-b2658afa; kiểm không bắt nhầm tiếng Việt thường). Toàn bộ: 645/645 đạt.
- Release `v0.24.27-67acb41605e4`: smoke 18/18, verify, cutover 11/11 (generation 52, rollback về `v0.24.26-dd52c45b67fe`). Remote `/mcp` không xác thực vẫn trả 401. Worker online, shadow, 5 model, restartCount 0.

### Job đối chiếu sau 0.24.27 — job-73984ad8-e12d-47c4-b6e9-81786c4c0064

| Mục | Kết quả |
|---|---|
| Check | L0_artifact_shape ✔, L0_no_instruction_leak ✔, L1_cross_family_judge ✔ |
| Rubric | 164 từ, đúng 5 ô `- [ ]`, tiếng Việt |
| Chi phí thật (ví portal) | 89.761,72 → 89.760,53 = **1,19 credit** (SBCE ghi bảo thủ 2đ) |
| Quyết định Brain | **Reject**: bước 4 khuyên xuất mật khẩu trình duyệt ra file HTML/CSV dạng chữ thường trên ổ rời — không an toàn; L1 không bắt được |

Kết luận: lỗi lọt chỉ dẫn đã hết; chi phí ổn định ~1,2 credit/job nhỏ. Vấn đề còn lại là **L1 không chấm khía cạnh an toàn**. Bước tiếp theo đề xuất: thêm tiêu chí an toàn mặc định (không khuyên lưu/xuất mật khẩu, khóa, dữ liệu nhạy cảm dạng chữ thường) vào prompt của judge và của writer.

## Bản 0.24.28 — tiêu chí an toàn mặc định cho writer và judge (ĐÃ CUTOVER)

- `src/sbce-runner.ts`: thêm `SBCE_SAFETY_BASELINE` (không khuyên lưu/xuất/gửi thông tin đăng nhập dạng chữ thường; không khuyên tắt lớp bảo vệ; dữ liệu nhạy cảm phải mã hóa/giới hạn quyền khi sao chép; không bước phá hủy khi chưa có bản sao lưu đã kiểm). Writer nhận trong system prompt; judge nhận dưới mục "SAFETY CRITERIA", vi phạm ⇒ `pass=false`, lý do được gửi lại cho writer.
- Test: `test/sbce-v02428.test.mjs`. Toàn bộ: 647/647 đạt.
- Release `v0.24.28-590b34e40105`: smoke 18/18, verify, cutover 11/11 (generation 53, rollback về `v0.24.27-67acb41605e4`). Remote `/mcp` vẫn 401. Worker online, shadow, 5 model, restartCount 0.

### Job đối chiếu sau 0.24.28 — job-c523bb2d-0258-469e-9eda-494119fdb66f — ĐẠT

| Mục | Kết quả |
|---|---|
| Check | L0_artifact_shape ✔, L0_no_instruction_leak ✔, L1_cross_family_judge ✔ (đạt ngay lần viết đầu) |
| Rubric | 189 từ (không tính ký hiệu markdown), đúng 5 ô `- [ ]`, các bước cụ thể |
| An toàn | Có lưu ý không ghi mật khẩu vào tệp, mã hóa dữ liệu nhạy cảm, kiểm bản sao |
| Chi phí thật (ví portal) | 89.760,53 → 89.758,76 = **1,77 credit** (tăng từ ~1,2 do prompt dài hơn và bản nháp dài hơn; SBCE ghi 2đ) |
| Quyết định Brain | **Accept** |

Kết luận: chuỗi P1 cho job văn bản nhỏ đạt cả ba mặt — chi phí (~1,8 credit/job), không lọt chỉ dẫn, nội dung an toàn. Các mục roadmap còn lại vẫn chờ bằng chứng ngoài (Golden Set baseline, Windows Sandbox, ≥2 tuần telemetry, 7 ngày on-mode + diễn tập rollback).
