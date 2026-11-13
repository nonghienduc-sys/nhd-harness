# NHD Tool Governor + Memory Resolver — v0.18

## Mục tiêu

Giảm orchestration/tool call thừa giữa ChatGPT Web và NHD MCP mà không làm ChatGPT mất khả năng biết MCP có những công cụ gì và không hạ thấp tiêu chuẩn QA.

Nguyên tắc cốt lõi:

> ChatGPT luôn biết toàn bộ capability của MCP. Governor không ẩn tool. Governor chỉ cung cấp kế hoạch tối thiểu, memory liên quan, soft budget, cache an toàn, phát hiện lặp và quality floor.

## Kiến trúc

```text
User
  ↓
ChatGPT Web
  ↓
Global capability awareness (all MCP tools remain registered/visible)
  ↓
Tool Governor (deterministic, no LLM required)
  ├─ Task classifier
  ├─ Project-aware Memory Resolver
  │   ├─ Global preferences
  │   ├─ Project preferences
  │   ├─ Structured project facts/decisions
  │   ├─ Similar completed tasks
  │   └─ Learned Task Recipe
  ├─ Quality Floor
  ├─ Soft Tool Budget
  ├─ Redundancy Detector
  ├─ Safe Meta Cache
  └─ Progressive Escalation hints
  ↓
Existing NHD MCP Core
  ├─ Direct Fast Lane
  ├─ Risk Policy
  ├─ Durable Task Runtime
  ├─ Office / PDF / OCR / Browser / Cốc Cốc
  ├─ Files / Terminal / Desktop
  └─ Local Intelligence lanes
```

## Không ẩn capability

`tool_governor action=capabilities` trả bản đồ toàn bộ tool theo nhóm. `hiddenCapabilities=false` là invariant thiết kế.

MCP vẫn đăng ký toàn bộ tool bình thường. ChatGPT không phải prompt thủ công “dùng OCR”, “dùng Word Live”, “dùng Cốc Cốc”. Governor chỉ khuyến nghị đường ngắn nhất.

## Khi nào gọi Governor

- Một thao tác trực tiếp, tool hiển nhiên: giữ Direct Fast Lane, không cần Governor.
- Task nhiều bước hoặc chưa rõ workflow tối ưu: gọi `tool_governor action=plan` đúng một lần.
- Không lặp `plan` trong cùng task trừ khi task thay đổi đáng kể.

## Memory

### 1. Global preference

Áp dụng xuyên project khi người dùng nói rõ một quy tắc chung.

Ví dụ: cách xác nhận, phong cách vận hành chung.

### 2. Project preference

Áp dụng riêng project.

Ví dụ TOEIC:
- 3 câu/lượt.
- Chữa đáp án + lập luận + từ mới.
- Word 13pt.

Ví dụ Quốc Anh:
- Bản năm trước chỉ tham khảo format, không sao chép nội dung.

### 3. Existing project memory

Governor không tạo một “bộ não thứ hai” tách biệt. Nó tái sử dụng Workspace Memory hiện có:
- structured facts,
- confirmed/verified decisions,
- durable tasks,
- semantic checkpoints.

Retrieval luôn bounded và xếp hạng theo task hiện tại; không dump toàn bộ chat history.

### 4. Task Recipe Memory

Khi một Governor plan kết thúc bằng semantic checkpoint hoặc completed durable task, Governor học chuỗi tool đã thực sự dùng thành recipe của `project + task class`.

Lưu:
- tool workflow,
- success count,
- use count,
- last duration,
- last tool count.

Recipe chỉ là advisory workflow, không phải authorization.

### 5. Preference history

`governor_preference_events` lưu previous/current value. Current preference luôn thắng preference cũ. Giá trị giống credential/secret bị từ chối.

## Task classes hiện có

- `toeic_word_grading`
- `word_live_edit`
- `financial_document_fill`
- `ocr_document`
- `web_research`
- `browser_form`
- `video_storyboard`
- `mcp_development`
- `mcp_health`
- `file_management`
- `general_workstation`

## Quality Floor

Governor không được phép giảm tool count bằng cách bỏ bước bắt buộc.

Ví dụ:

### TOEIC
- đọc đúng bài hiện tại,
- chấm đáp án và lập luận,
- giữ project preference/format,
- verify phần Word vừa sửa.

### CMC / tài chính
- xác định đúng kỳ / đúng entity,
- ưu tiên native source; OCR chỉ khi cần,
- tính lại derived values,
- verify bảng/range đã điền.

### MCP development
- inspect source/runtime,
- rollback evidence cho production change,
- build + regression,
- restart safety + health verification khi cutover.

## Soft Tool Budget

Budget là advisory, không phải hard cap.

Representative defaults:

| Task | Expected | Soft limit |
|---|---:|---:|
| TOEIC grading | 3 | 5 |
| MCP health | 1 | 2 |
| Word live edit | 3 | 5 |
| CMC financial fill | 6 | 9 |
| OCR document | 4 | 7 |
| MCP development | 8 | 14 |

Vượt budget được phép khi có:
- evidence mới,
- lỗi cần recovery,
- quality-floor verification,
- task thay đổi phạm vi.

## Redundancy Detector

Governor fingerprint `tool + args` và phát hiện exact duplicate trong cửa sổ ngắn. Đây là telemetry/advice; các thao tác thực không bị tự động replay hay tự động bỏ qua nếu cần evidence mới.

## Safe Meta Cache

Chỉ cache nhóm meta-read rủi ro thấp và ít biến động:
- skill discovery/validation,
- local AI status,
- project lookup.

Không cache các nguồn sống/dynamic quan trọng như:
- `office_live_read`,
- workstation health,
- browser/Cốc Cốc DOM,
- filesystem read/stat/list,
- context bootstrap/recall,
- project status.

Mọi mutation làm clear meta cache.

## Safety

Tool Governor:
- không execute workstation action;
- không grant authorization;
- không thay NHD Risk Policy;
- không thay Durable Task Runtime;
- không replay ambiguous action;
- không dùng LLM riêng;
- không lưu prompt/task body lâu dài;
- preference memory chặn credential/secret pattern.

## Benchmark cục bộ 2026-10-09

Script: `scripts/benchmark-tool-governor.mjs`

5.000 plan/case, bounded synthetic project memory:

| Case | Mean latency | Expected calls | Soft limit |
|---|---:|---:|---:|
| TOEIC grading | 0.112313 ms | 3 | 5 |
| CMC financial fill | 0.096998 ms | 6 | 9 |
| MCP development | 0.080626 ms | 8 | 14 |

Capability map: 10.000 iterations, mean `0.005674 ms`.

Đây là benchmark deterministic local layer, không bao gồm latency Word/browser/LLM/network.

## Test coverage

Dedicated tests cover:
- full capability awareness / no hidden tools,
- bounded project memory,
- project preference replacement/history,
- safe metadata cache vs uncached live Word,
- learned task recipe after successful checkpoint.

Full regression candidate after integration: `250/250 PASS` before final version packaging/cutover.

## Expected operating behavior

Ví dụ người dùng trong TOEIC chỉ nói:

> Tôi làm xong rồi, chữa cho tôi.

Governor plan should resolve:
- project TOEIC,
- current 3-question preference,
- known grading format/decisions,
- prior recipe if available,
- expected ~3 calls,
- avoid ritual skill discovery / full document reread / terminal unless fallback is needed.

Ví dụ cùng lúc người dùng yêu cầu MCP source patch:
- task class changes to `mcp_development`,
- budget expands automatically,
- regression/rollback/health remain mandatory.

Người dùng không cần prompt tên tool.
