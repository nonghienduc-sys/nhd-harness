# NHD MCP v0.17 — Direct Fast Lane + Optional Local Text Worker

## Quyết định kiến trúc

Không thay thế kiến trúc cũ `ChatGPT Web -> MCP -> Skill/Tool`.

Kiến trúc cũ được giữ nguyên làm **Direct Fast Lane**. Local AI là một nhánh tùy chọn chỉ dành cho bounded text work khi nó có lợi ích đo được.

```text
                         ChatGPT Web
                              |
                              v
                           NHD MCP
                              |
                    advisory dispatcher
                              |
        +---------------------+--------------------+
        |                     |                    |
        v                     v                    v
  DIRECT FAST LANE       LOCAL TEXT LANE       CLOUD LANE
 ChatGPT->MCP->Tool      Qwen 1.5B local       ChatGPT cloud
        |                     |                    |
  Skill / Tool            extract               current web
  search/open/read        summarize             deep reasoning
  multi-step tool plan    rewrite               high-stakes
        |                     |
        +----------+----------+
                   v
             existing NHD safety
        Task Runtime / Risk Policy
```

## Dispatcher lanes

### `direct_tool`

Giữ đường cũ. Không thêm local-model hop.

Dùng cho:

- mở/focus ứng dụng;
- đọc/search file/project/memory;
- gọi skill/tool đã xác định;
- workflow nhiều bước mà ChatGPT Web đã là planner/orchestrator;
- tác vụ có side effect cần NHD Risk Policy.

### `context_gate`

Dùng cho câu phụ thuộc trạng thái như `làm đi`, `tiếp tục`, `xác nhận...`. Resolve từ durable task/project/chat memory trước; không cho model đoán chỉ từ câu chữ.

### `local_text_worker`

Qwen2.5-1.5B-Instruct Q4_K_M chạy CPU-only qua llama.cpp. Chỉ hỗ trợ:

- `extract` với explicit JSON fields;
- `summarize`;
- `rewrite`.

Không hỗ trợ tool calling, không tự save/write/click/send. Output luôn `advisoryOnly=true`, `mayExecute=false`, `mayCallTools=false`, `contentVerified=false`.

Nếu NHD tự start worker, worker được dừng sau 90 giây idle. Nếu một llama-server đã chạy sẵn ngoài NHD, NHD có thể reuse nhưng không sở hữu và không tự kill process đó.

### `cloud`

Giữ ChatGPT cho:

- web/current/fresh information;
- deep reasoning;
- research;
- high-stakes interpretation;
- tác vụ vượt giới hạn local worker.

## Benchmark

### Dispatcher overhead

100,000 dispatches trên máy hiện tại:

- total: ~735.3 ms;
- mean: ~0.00735 ms/request.

Dispatcher là advisory; với request hiển nhiên ChatGPT có thể gọi MCP tool trực tiếp và không cần gọi dispatcher, do đó Direct Fast Lane không bị bắt buộc chịu overhead này.

### Persistent Qwen benchmark trước khi tích hợp

- Qwen 0.5B routing: 12.5%; không dùng làm router.
- Qwen 1.5B routing: 62.5%; vẫn thua NHD hybrid/tiny 100% trên tập kiểm thử.
- Qwen 1.5B schema extraction: ~91.7% mean field accuracy trong benchmark 6 case.
- Qwen 1.5B rewrite: ~81.7% constraint preservation.
- Qwen 1.5B summary: ~88.3% fact retention.
- Qwen 1.5B working set: khoảng 1.36 GB khi resident.

### Staging smoke v0.17

Qwen 1.5B trả đúng JSON shape cho `{name, code}` nhưng biến `HS-482` thành `482`. Điều này chứng minh schema correctness không đồng nghĩa factual correctness. Vì vậy local worker không được quyền tự quyết định hoặc tự thực thi downstream action.

## MCP tools mới

- `local_ai_dispatch`: advisory lane selection only.
- `local_ai_text_worker`: explicit bounded local inference only.

Các tool cũ vẫn giữ nguyên. Không tool cũ nào bị bắt buộc đi qua Local AI.

## Safety invariants

1. Direct Fast Lane luôn tồn tại.
2. Local AI không phải authorization.
3. Local worker không được tool-call.
4. NHD Risk Policy vẫn là authorization authority duy nhất.
5. NHD Task Runtime vẫn là task-state authority duy nhất.
6. Current/deep/high-stakes không được tự động hạ xuống local worker.
7. Extraction chỉ xác minh JSON/schema shape; factual content vẫn chưa được verify.
8. Interrupted/ambiguous action không được tự replay.
9. External model endpoint bị chặn; local worker chỉ cho loopback.
10. Existing external llama-server không bị NHD tự kill.

## Production default

`local_ai_dispatch` không tự chạy cho mọi request. ChatGPT có thể tiếp tục gọi skill/tool trực tiếp như trước. `local_ai_text_worker` chỉ được gọi khi bounded local text processing có lợi ích rõ ràng.
