# Hướng dẫn sử dụng Brain trong NHD Harness

Tài liệu này dành cho người dùng và cho chính Brain (Claude, ChatGPT, Gemini… kết nối NHD qua MCP).
Bản tóm tắt luật ngắn nằm ở [BRAIN_RULES.md](BRAIN_RULES.md); thiết kế kỹ thuật ở
[STRONG-BRAIN-CHEAP-EXECUTOR-2026-11-12.md](STRONG-BRAIN-CHEAP-EXECUTOR-2026-11-12.md).

Mục lục
1. Ý tưởng chung
2. Ba chế độ làm việc
3. Đổi chế độ (lệnh chat và dashboard)
4. Quy trình giao việc từng bước
5. Viết phiếu giao việc (work order)
6. Theo dõi và duyệt job
7. Xử lý job lỗi
8. Chi phí, model và giới hạn
9. Brain được và không được tự làm gì
10. Lỗi thường gặp
11. Mẫu phiếu theo loại việc
12. Câu hỏi thường gặp

---

## 1. Ý tưởng chung

- **Brain** (model mạnh, trả theo gói thuê bao) chỉ suy nghĩ: hiểu yêu cầu, chia việc, viết phiếu, duyệt kết quả, báo cáo người dùng.
- **Worker** (model bé, rẻ, gọi qua API HHTECH) làm tay: đọc/tóm tắt, viết văn bản, viết code, viết test.
- **NHD** đứng giữa: nhận phiếu, chọn model, cho worker làm trong sandbox, tự kiểm tra bằng máy (L0) và bằng một model khác họ (L1), tự sửa vài lần, rồi trả biên nhận gọn cho Brain.

Lợi ích: Brain đỡ tốn context và lượt dùng; việc nặng chạy bằng model rẻ có trần chi phí.

## 2. Ba chế độ làm việc

| Chế độ | Tên trong hệ thống | Brain tự sửa tệp / chạy lệnh | Giao việc cho model bé | Dùng khi |
|---|---|---|---|---|
| **1** | `harness` | Không (chỉ lệnh kiểm chứng ngắn) | Có, là đường mặc định | Việc nhiều, lặp lại, muốn tiết kiệm lượt Brain |
| **2** | `self` | Có, qua harness | **Không** (`delegate_task submit/run` bị chặn) | Việc nhỏ, cần chính xác cao, hoặc model bé đang làm hỏng |
| **3** | `direct` | Có, không ràng buộc | Có thể, không bắt buộc | Sửa chính harness, xử lý sự cố, việc cần toàn quyền |

Chi tiết chặn ở **chế độ 1** (hook `scripts/claude-brain-mode-hook.mjs`):
- `Edit / Write / NotebookEdit / MultiEdit` chỉ được ghi trong `C:/Users/ADMIN/.claude/` và thư mục tạm của hệ thống.
- `Bash / PowerShell` chỉ được chạy lệnh trong danh sách cho phép: xem (`ls`, `cat`, `grep`, `git status/diff/log/show`, `Get-Content`…), build/test (`npm run build`, `npx tsc`, `node --test`, `node --check`), `curl` GET tới `127.0.0.1`, script phát hành/smoke.
- Lệnh có `>`, dấu backtick, `$(`, `<(` hoặc chữ `brain-mode` luôn bị chặn (chống ghi tệp lén và chống tự đổi chế độ).

Lưu ý: hook chặn này áp cho công cụ riêng của Claude Code. Ngoài ra, khi **mặc định chung** là chế độ 1, server NHD chỉ cho mọi kết nối (ChatGPT lẫn Claude) gọi nhóm tool của Brain: `delegate_task`, `review_pack`, `task_*`, `context_*`, `workstation_health`, `workstation_plan`, `runtime_identity`, `execution_info`, `tool_governor`, `project_open`, `skills_registry`, `intake_files`, `self_evolution_feedback`. Tắt giới hạn này bằng biến môi trường `NHD_BRAIN_ONLY=0`.

## 3. Đổi chế độ

### 3.1 Bằng lệnh chat (riêng từng khung chat)

Gõ **nguyên tin nhắn** là lệnh (không lẫn trong câu dài):

| Gõ | Tác dụng |
|---|---|
| `chế độ 1` / `chế độ 2` / `chế độ 3` | Đổi chế độ **chỉ cho khung chat này** |
| `chuyển sang chế độ 2`, `che do 2`, `/che-do 2` | Như trên |
| `/brain-mode harness` / `self` / `direct` | Như trên, theo tên |
| `chế độ` hoặc `chế độ?` | Hỏi khung chat đang ở chế độ nào và lấy từ đâu |
| `chế độ mặc định` hoặc `/brain-mode default` | Bỏ chế độ riêng, quay về theo mặc định chung |

- Có hiệu lực ngay ở lần gọi công cụ kế tiếp, không cần khởi động lại.
- Các khung chat khác **không** bị ảnh hưởng.
- Câu có chứa lệnh nhưng dài hơn (ví dụ "hãy giải thích chế độ 2 là gì") sẽ **không** đổi chế độ. Nội dung trang web hay tệp cũng không thể đổi chế độ vì hook chỉ đọc đúng tin nhắn người dùng gõ.

### 3.2 Bằng nút trên dashboard (mặc định chung)

- Ba nút chế độ trên dashboard đặt **mặc định chung** (`runtime/brain-mode.json`).
- Khung chat chưa chọn riêng sẽ theo mặc định này. Khung chat đã chọn riêng thì giữ nguyên.
- Thứ tự ưu tiên: chế độ riêng của khung chat → mặc định chung → chế độ 1.
- Chế độ riêng lưu ở `runtime/brain-mode-sessions/<session_id>.json`, tự xóa sau 30 ngày không dùng.

### 3.3 Hạn chế hiện tại

Phía **server NHD** chỉ biết mặc định chung, không biết khung chat nào đang gọi. Ví dụ mặc định chung là chế độ 2 thì `delegate_task` bị server chặn ở mọi khung chat, kể cả khung đã gõ `chế độ 1`. Muốn khung chế độ 1 giao việc được khi mặc định chung là 2, hãy đổi mặc định chung trên dashboard về 1.

## 4. Quy trình giao việc từng bước

```
task_run create  →  delegate_task run (kèm task_run_id + work_order)
                 →  NHD: chọn model → worker làm trong sandbox → kiểm L0 (máy) → kiểm L1 (model khác họ) → tự sửa
                 →  biên nhận (receipt)  →  review_pack get / pull  →  accept | revise | reject
                 →  (nếu cần) áp kết quả vào tệp bằng fs_preview_write → fs_apply_write
                 →  báo cáo người dùng
```

1. **Tạo task run**: `task_run` action `create` với `objective`. Bỏ trống `root` cho việc mới; chỉ đưa `root` khi tiếp tục một dự án có sẵn. Ghi lại `task_run_id`.
2. **Giao việc**: `delegate_task` action `run` (gửi và chờ trong một lần gọi, mặc định chờ 240 s, tối đa 300 s). Dùng `submit` nếu muốn gửi rồi làm việc khác.
3. **Đọc biên nhận**: trạng thái, các check đã qua/trượt, rủi ro, chi phí, chẩn đoán.
4. **Xem bản nháp**: `review_pack` action `pull` (mặc định 4.000 ký tự, tối đa 8.000).
5. **Quyết định**: `review_pack` `accept` / `revise` / `reject`, kèm `note` ngắn. Duyệt chỉ đổi trạng thái job, **không** tự ghi tệp.
6. **Áp vào dự án** (nếu là sửa code/tài liệu): dùng đường xem trước rồi ghi (`fs_preview_write` → `fs_apply_write`), không có lối tắt.
7. **Báo cáo** người dùng: làm gì, kiểm gì, còn gì chưa kiểm.

Nếu `context_report` xuất hiện trong kết quả: một phần ngữ cảnh đã **không** được gửi cho worker (quá lớn). Hãy chia nhỏ job hoặc thu hẹp `context_refs`.

## 5. Viết phiếu giao việc (work order)

| Trường | Bắt buộc | Ý nghĩa / giới hạn |
|---|---|---|
| `title` | Có | 3–200 ký tự |
| `kind` | Có | `code_change`, `doc_write`, `doc_edit`, `data_extract`, `research`, `shell_task`, `test_write` |
| `goal` | Có | 10–10.000 ký tự. Viết rõ đầu vào, đầu ra, phạm vi |
| `deliverables` | Có | 1–20 dòng, mỗi dòng một sản phẩm cụ thể (tệp + nội dung chính) |
| `acceptance` | Có | 1–30 tiêu chí, ưu tiên tiêu chí máy kiểm được (xem dưới) |
| `context_refs` | Không | Tối đa 12 tham chiếu được đọc, dạng `đường/dẫn/tương/đối` hoặc `tệp:10-80`. Không dùng đường dẫn tuyệt đối hay `..` |
| `constraints` | Không | Tối đa 30 ràng buộc ("chỉ sửa tệp X", "không thêm thư viện") |
| `locked_paths` | Không | Tệp/thư mục worker không được đụng; vi phạm → `SBCE_LOCKED_PATH` |
| `risk` | Không | `low` / `medium` (mặc định) / `high`. `high` bắt buộc `sandbox_only` |
| `budget` | Không | `vnd` ≤ 20.000, `minutes` ≤ 30, `max_attempts` ≤ 6 (mặc định là mức trần) |
| `escalation` | Không | `allow_t3` (cho dùng model đắt nhất, mặc định có); `ask_brain_on`: `ambiguity`, `acceptance_conflict`, `budget_exhausted`, `high_risk` |
| `apply_mode` | Không | `sandbox_only` (mặc định) hoặc `apply_after_accept` |
| `project_root` | Nên có với code | Thư mục dự án; cần để NHD chạy kiểm L0 trên bản sao |

### Các loại tiêu chí `acceptance`

| `type` | Trường dùng | Kiểm gì |
|---|---|---|
| `command` | `run`, `expect` (tùy chọn) | Chạy lệnh trên bản sao dự án, phải thành công (và khớp `expect` nếu có) |
| `grep_absent` | `pattern`, `paths` | Mẫu không được xuất hiện trong các tệp |
| `artifact_exists` | `paths` | Tệp phải tồn tại |
| `schema` | `text` | Đầu ra phải đúng cấu trúc mô tả |
| `rubric` | `text` | Tiêu chí bằng lời, do model judge chấm (yếu nhất, nên kèm tiêu chí máy) |

### Mẹo viết phiếu tốt

- **Một phiếu một việc.** Việc lớn chia nhiều phiếu nhỏ; mỗi phiếu kiểm được độc lập.
- **Ưu tiên tạo tệp mới** hơn vá nhiều chỗ trong tệp lớn; model bé vá dòng hay trượt.
- **Đưa đúng ngữ cảnh**: dùng `context_refs` có khoảng dòng thay vì cả tệp.
- **Tiêu chí máy trước, rubric sau.** Ít nhất một `command` (typecheck/test) cho việc code.
- **Ghi rõ những gì không được làm** trong `constraints` và `locked_paths`.
- **Không đưa secret thật** (API key, mật khẩu, token) vào bất kỳ trường nào.

## 6. Theo dõi và duyệt job

### Trạng thái job

| Trạng thái | Nghĩa | Brain làm gì |
|---|---|---|
| `queued`, `running`, `verifying`, `fixing` | Đang chạy | Chờ: `delegate_task status` với `wait_s` |
| `ready_for_review` | Qua L0 và L1, chờ duyệt | `review_pack pull` xem bản nháp → `accept` / `revise` / `reject` |
| `needs_brain` | Worker không đạt hết cổng kiểm, hoặc cần Brain quyết | Đọc `diagnosis`, sửa phiếu và giao lại (mục 7) |
| `accepted` | Brain đã duyệt | Áp kết quả nếu cần (mục 4 bước 6) |
| `applied` | Đã áp vào tệp | Kiểm lại và báo cáo |
| `failed` | Lỗi hoặc bị trả lại | Xem lỗi, quyết định giao lại hay bỏ |
| `cancelled` | Đã hủy | — |

Các action của `delegate_task`: `submit`, `run`, `status`, `list` (job của một task run), `cancel`. (`answer` chưa hỗ trợ: muốn bổ sung thông tin thì gửi phiếu mới.)

Các action của `review_pack`: `get` (biên nhận), `pull` (bản nháp), `accept`, `revise`, `reject`. Chỉ duyệt được job ở `ready_for_review` (nếu không: `SBCE_NOT_READY_FOR_REVIEW`).

### Khi duyệt cần nhìn

- Mọi check L0 đều `ok`? Có check nào bị bỏ qua?
- Mục `risks`: worker có đụng ngoài phạm vi, có chỗ "chưa chạy thử"?
- Bản nháp có đúng `deliverables` không, có thêm thứ không yêu cầu không?
- Chi phí có bất thường không?

## 7. Xử lý job lỗi (`needs_brain`, `failed`)

1. Đọc `diagnosis` và các check trượt.
2. Sửa nguyên nhân trong phiếu: chia nhỏ hơn, thêm ngữ cảnh đúng chỗ, viết tiêu chí rõ hơn, chuyển từ vá dòng sang tạo tệp mới.
3. Giao lại bằng phiếu mới.
4. Sau 2 lần vẫn hỏng: **hỏi người dùng** trước khi Brain tự làm (hoặc người dùng chuyển khung chat sang `chế độ 2`).
5. **Không hủy job** đang chạy khi chưa xem kết quả và chưa báo người dùng.

## 8. Chi phí, model và giới hạn

- Trần mỗi job: **20.000 VND**, 30 phút, 6 lần thử (tối đa 2 lần mỗi tầng model). Trần mỗi ngày: **300.000 VND**.
- Model chia tầng T1 (rẻ) → T2 → T3 (đắt). NHD thử tầng rẻ trước, chỉ leo khi trượt kiểm (cho phép T3 nếu `allow_t3`).
- Kiểm L1 dùng model **khác họ** với model làm việc.
- Xem tình trạng: `executor_admin` action `status`, `budget`, `catalog`, `eval_report` (chỉ đọc, không lộ key).
- Danh mục model ở `C:\ProgramData\ChatGPTWorkstationBridge\sbce-model-catalog.json`; đổi model là sửa catalog, không sửa code.

## 9. Brain được và không được tự làm gì

Được (mọi chế độ):
- Đọc tệp, tìm kiếm, xem diff, chạy typecheck/test, gọi `curl` GET nội bộ, xem dashboard.
- Viết phiếu, duyệt, báo cáo.

Phải được người dùng cho phép **rõ ràng, từng lần**:
- `git commit`, `git push` (kho `D:\ChatGPT-Workstation-MCP` trỏ tới GitHub **công khai**).
- Phát hành (release), cutover, restart server.
- Tự làm thay worker khi đang ở chế độ 1.
- Hủy job.

Cấm:
- Gửi secret thật cho worker.
- Đọc hay in ra token trong `~/.claude/settings.json`.
- Tự đổi chế độ bằng lệnh shell hoặc sửa tệp `brain-mode*`.

Dashboard (`D:\ChatGPT-Workstation-MCP\dashboard`) là HTML/JS tĩnh: sửa tệp có hiệu lực ngay, không cần cutover hay restart.

## 10. Lỗi thường gặp

| Mã lỗi | Nghĩa | Cách xử lý |
|---|---|---|
| `SBCE_TASK_RUN_REQUIRED` | Thiếu `task_run_id` | Tạo `task_run create` rồi gửi lại |
| `SBCE_DISABLED` | SBCE đang tắt (`mode=off`) | Báo người dùng; Brain tự làm nếu được phép |
| `SBCE_HIGH_RISK_REQUIRES_OWNER` | `risk: high` mà không `sandbox_only` | Đặt `apply_mode: sandbox_only` |
| `SBCE_SHADOW_SANDBOX_ONLY` | SBCE ở chế độ shadow | Chỉ dùng `sandbox_only` |
| `SBCE_CONTEXT_REF_INVALID` / `_LIMIT` / `_MISSING` | Tham chiếu ngữ cảnh sai, quá 12, hoặc không có tệp | Dùng đường dẫn tương đối với `project_root`, đúng dạng `tệp:đầu-cuối` |
| `SBCE_CONTEXT_TOO_LARGE` | Ngữ cảnh quá lớn | Thu hẹp khoảng dòng, chia job |
| `SBCE_LOCKED_PATH` | Worker đụng tệp bị khóa | Kiểm lại phiếu; giao lại rõ phạm vi hơn |
| `SBCE_EDIT_SEARCH_NOT_FOUND` / `_AMBIGUOUS` | Worker vá dòng sai chỗ | Chia nhỏ hoặc cho tạo tệp mới |
| `SBCE_MACHINE_ACCEPTANCE_FAILED`, `SBCE_CHECKS_NOT_PASSED` | Trượt kiểm máy | Xem check trượt, sửa phiếu |
| `SBCE_JOB_BUDGET_EXCEEDED`, `SBCE_DAILY_BUDGET_EXCEEDED`, `SBCE_BUDGET_OR_ATTEMPT_LIMIT` | Hết ngân sách / số lần thử | Chia nhỏ job; chờ sang ngày; báo người dùng |
| `SBCE_CALL_BILLING_EXCEEDS_CEILING` | Phí thật của một lần gọi vượt mức đã giữ chỗ (route có token ẩn) | Lỗi hệ thống, không phải lỗi phiếu: báo người dùng. Đã có bản sửa `hiddenInputTokens` |
| `SBCE_CROSS_FAMILY_JUDGE_UNAVAILABLE` | Không có model khác họ để kiểm L1 | Báo người dùng kiểm catalog |
| `SBCE_NOT_READY_FOR_REVIEW` | Duyệt job chưa ở `ready_for_review` | Chờ hoặc xem trạng thái |
| `SBCE_APPLY_REQUIRES_EXISTING_PREVIEW_APPLY` | Cố đánh dấu `applied` không qua đường preview/apply | Áp bằng `fs_preview_write` → `fs_apply_write` |
| `SBCE_GENERATED_SECRET_BLOCKED` | Bản nháp chứa thứ giống secret | Kiểm lại; không đưa secret vào phiếu |

## 11. Mẫu phiếu theo loại việc

### Sửa code (`code_change`)
```json
{
  "title": "Thêm hàm tính tổng",
  "kind": "code_change",
  "goal": "Thêm hàm sum(a:number[]):number vào src/util.ts, trả 0 với mảng rỗng.",
  "project_root": "D:\\Du-an",
  "context_refs": ["src/util.ts:1-60"],
  "deliverables": ["src/util.ts: export function sum(a:number[]):number"],
  "acceptance": [
    {"type": "command", "run": "npx tsc --noEmit -p ."},
    {"type": "grep_absent", "pattern": "console.log", "paths": ["src/util.ts"]},
    {"type": "rubric", "text": "Chỉ sửa src/util.ts; mảng rỗng trả 0"}
  ],
  "constraints": ["Không thêm thư viện", "Không commit"],
  "risk": "low"
}
```

### Viết test (`test_write`)
```json
{
  "title": "Test cho hàm sum",
  "kind": "test_write",
  "goal": "Viết test node:test cho sum(): mảng rỗng, số âm, số thực.",
  "project_root": "D:\\Du-an",
  "context_refs": ["src/util.ts"],
  "deliverables": ["test/util-sum.test.mjs"],
  "acceptance": [
    {"type": "artifact_exists", "paths": ["test/util-sum.test.mjs"]},
    {"type": "command", "run": "node --test test/util-sum.test.mjs"}
  ],
  "locked_paths": ["src/"]
}
```

### Viết tài liệu (`doc_write`)
```json
{
  "title": "Viết README cho module util",
  "kind": "doc_write",
  "goal": "Viết docs/util.md tiếng Việt: mục đích, danh sách hàm, ví dụ dùng sum().",
  "project_root": "D:\\Du-an",
  "context_refs": ["src/util.ts"],
  "deliverables": ["docs/util.md"],
  "acceptance": [
    {"type": "artifact_exists", "paths": ["docs/util.md"]},
    {"type": "rubric", "text": "Có đủ 3 mục; ví dụ chạy đúng với code hiện tại"}
  ]
}
```

### Trích dữ liệu (`data_extract`)
```json
{
  "title": "Trích danh sách endpoint",
  "kind": "data_extract",
  "goal": "Liệt kê mọi route express trong src/server.ts thành JSON [{method,path}].",
  "project_root": "D:\\Du-an",
  "context_refs": ["src/server.ts"],
  "deliverables": ["JSON trong bản nháp"],
  "acceptance": [
    {"type": "schema", "text": "Mảng các object {method: string, path: string}"},
    {"type": "rubric", "text": "Không bỏ sót route nào trong tệp"}
  ]
}
```

## 12. Câu hỏi thường gặp

**Tôi đổi chế độ ở khung chat này, khung chat khác có bị đổi không?**
Không. Lệnh chat chỉ đổi khung chat đã gõ. Nút dashboard chỉ đổi mặc định chung cho các khung chưa chọn riêng.

**Làm sao biết khung chat đang ở chế độ nào?**
Gõ `chế độ`. Câu trả lời ghi rõ chế độ và nguồn (riêng khung chat hay mặc định chung).

**Brain có tự đổi chế độ được không?**
Không. Chỉ người dùng gõ lệnh hoặc bấm nút. Hook chặn mọi lệnh shell có chữ `brain-mode`.

**Model bé làm hỏng liên tục thì sao?**
Chia nhỏ phiếu và giao lại; sau 2 lần vẫn hỏng thì hỏi người dùng hoặc chuyển khung chat sang `chế độ 2`.

**Job đang chạy lâu, có nên hủy?**
Không tự hủy. Xem trạng thái với `wait_s`, báo người dùng, chỉ hủy khi được đồng ý.

**Duyệt `accept` xong tệp đã được sửa chưa?**
Chưa. Duyệt chỉ đổi trạng thái job. Muốn áp vào dự án phải qua `fs_preview_write` → `fs_apply_write`.
