# Persistent Local Text Worker Benchmark — 2026-10-09

## Mục tiêu

So sánh NHD v0.16.1 hybrid/tiny fast path với local LLM chạy persistent llama.cpp trên máy hiện tại, tập trung vào routing, extraction, summarization, rewrite, latency và RAM.

## Máy benchmark

- CPU: Intel Core i7-11850H, 8C/16T
- RAM: 15.73 GB usable
- GPU: Intel UHD
- llama.cpp: b11490
- CPU-only, 8 threads, context 2048

## Kết luận ngắn

- Routing: dùng NHD hybrid/tiny, không dùng LLM.
- Text worker chất lượng cao hơn: Qwen2.5-1.5B-Instruct Q4_K_M.
- Text worker siêu nhẹ/nhanh hơn: Qwen2.5-0.5B-Instruct Q4_K_M, nhưng chất lượng thấp hơn đáng kể.
- Không nên chạy đồng thời cả 0.5B và 1.5B trên máy 16 GB trong sử dụng bình thường.
- Production model invocation vẫn OFF.

## Routing

Bộ 24 lệnh representative:

| Engine | Accuracy | Mean latency |
|---|---:|---:|
| NHD hybrid/tiny v0.16.1 | 24/24 = 100% | ~0.01 ms |
| Qwen 0.5B persistent | 3/24 = 12.5% | ~268 ms |
| Qwen 1.5B persistent | 15/24 = 62.5% | ~323 ms |

Kết luận: LLM không nên thay router hybrid. Context-dependent commands tiếp tục đi qua durable task/project memory gate.

## Summarization

Fact-retention benchmark:

| Model | Score | Mean latency |
|---|---:|---:|
| Qwen 0.5B | ~83.3% | ~1.10 s |
| Qwen 1.5B | ~88.3% | ~2.24 s |

0.5B nhanh hơn; 1.5B giữ ý tốt hơn một chút.

## Rewrite

Constraint-preservation benchmark:

| Model | Score | Mean latency |
|---|---:|---:|
| Qwen 0.5B | ~68.3% | ~0.60 s |
| Qwen 1.5B | ~81.7% | ~1.41 s |

1.5B tốt hơn rõ rệt về giữ ràng buộc/ngữ nghĩa.

## Schema-constrained extraction

Đây là cách thực tế MCP nên gọi local text worker: truyền schema/key bắt buộc, JSON only, temperature 0.

| Model | Mean field accuracy | Perfect cases | Mean latency |
|---|---:|---:|---:|
| Qwen 0.5B | 58.3% | 2/6 | ~1.15 s |
| Qwen 1.5B | 91.7% | 4/6 | ~2.49 s |

1.5B thắng lớn ở extraction có schema. 0.5B thường đổi key/value hoặc làm mất tiền tố/ngữ cảnh.

## Footprint

Sau benchmark, khi cả hai server cùng chạy:

| Model | Working set | Private memory |
|---|---:|---:|
| Qwen 0.5B | ~626 MB | ~742 MB |
| Qwen 1.5B | ~1,357 MB | ~1,452 MB |

Free physical RAM còn ~2.39 GB khi cả hai server cùng chạy. Vì vậy production không nên giữ cả hai cùng resident.

Qwen 0.5B persistent startup từ cache: ~1.72 s. Lần khởi động 1.5B đầu tiên trong benchmark bao gồm cả tải model nên không dùng con số đó làm cold-start inference baseline.

## Kiến trúc khuyến nghị

```text
ChatGPT Web
   -> NHD MCP
      -> hard safety/currentness rules
      -> task/project context gate
      -> deterministic + tiny router
         -> simple routing/search/open: NHD native
         -> bounded extraction/rewrite/summary needing privacy/offline: Qwen 1.5B local worker (feature-flag / on-demand)
         -> deep/current/high-stakes reasoning: ChatGPT cloud
```

## Quyết định

1. Giữ NHD hybrid/tiny làm router production.
2. Không dùng Qwen 0.5B làm router.
3. Nếu tích hợp local text worker, ưu tiên Qwen 1.5B Q4_K_M cho extraction có schema, rewrite và summary khi cần local/private/offline.
4. Chạy 1.5B theo on-demand hoặc idle-timeout, không giữ cả 0.5B và 1.5B resident cùng lúc.
5. Mọi output local vẫn advisory; NHD Task Runtime/Risk Policy mới có quyền quyết định tool execution.
