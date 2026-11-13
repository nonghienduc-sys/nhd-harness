# NHD Local Intelligence Benchmark — 2026-10-09

## Máy benchmark

- CPU: Intel Core i7-11850H, 8C/16T
- RAM: 16 GB
- GPU: Intel UHD Graphics
- Inference target phù hợp: CPU/INT8; Intel UHD không có lợi thế cho LLM nhỏ trong benchmark này.

## Kết luận chính

Fast path không nên dùng LLM 0.5B. Kiến trúc tốt nhất trên máy này là:

```text
hard safety/currentness rules
        -> durable task/memory context gate
        -> deterministic command gates
        -> tiny character-trigram classifier fallback
        -> local/cloud escalation when needed
```

Local model generation vẫn tắt trong production.

## Baseline v0.16.0

### Holdout song ngữ 40 câu

- Deterministic router: 26/40 = 65.0%
- Warm routing latency: ~0.0020 ms/request

### Holdout user-style 36 câu

- Deterministic router: 21/36 = 58.3%
- Warm routing latency: ~0.0021 ms/request

## Tiny learned router

Prototype: character-trigram multinomial Naive Bayes.

### Holdout song ngữ 40 câu

- 38/40 = 95.0%
- Warm latency: ~0.0091 ms/request
- Training: ~1.23 ms
- Approximate prototype model table: ~37 KB

### Holdout user-style 36 câu

- 31/36 = 86.1%
- Warm latency: ~0.0108 ms/request

Các lỗi còn lại tập trung vào câu phụ thuộc ngữ cảnh như `làm đi`, `tiếp tục`, `xác nhận restart MCP`; vì vậy chúng không nên để classifier đoán từ text mà phải resolve qua durable task/project memory.

## Qwen2.5-0.5B-Instruct Q4_K_M / llama.cpp

Runtime: llama.cpp b11490.

Model:

- 630,167,424 parameters
- GGUF Q4_K_M: 485,452,288 bytes local

### CPU-only, 8 threads

- Prompt processing, 64 tokens: ~242.17 tok/s
- Generation: ~40.70 tok/s
- Cold CLI process invocation: ~6.6–7.3 s

### Intel UHD Vulkan

- Prompt processing: ~214.99 tok/s
- Generation: ~29.98 tok/s
- First tested cold invocation: ~10.5 s

CPU-only nhanh hơn Intel UHD trên cấu hình này.

### Routing quality

- Minimal classification prompt không ổn định.
- Few-shot sửa được một ví dụ đơn lẻ.
- Batch 10 requests không tuân thủ output contract; model trả ordinal numbers thay vì route labels.

Kết luận: Qwen 0.5B không phù hợp làm routing fast path trên máy hiện tại. Có thể giữ để nghiên cứu text-worker cục bộ sau này, ưu tiên CPU-only.

## v0.16.1 hybrid router

Sau refinement:

### Holdout song ngữ 40 câu

- 38/40 = 95.0%
- ~0.0056 ms/request cho hybrid service route

### Holdout user-style 36 câu

- Raw tier-label score: 32/36 = 88.9%
- 4 mismatch còn lại đều là câu phụ thuộc context và cố ý route sang `nhd-context-gate`.
- Chấm theo operational routing contract: 36/36 đúng tầng xử lý mong muốn.
- ~0.0046 ms/request.

## Safety

- Tiny router chỉ advisory.
- `mayExecute=false` giữ nguyên.
- Model inference vẫn `disabled`.
- NHD Task Runtime là task-state authority.
- NHD Risk Policy là authorization authority.
- External side effects vẫn đi qua policy gate hiện có.
- Interrupted/ambiguous actions không tự replay.
