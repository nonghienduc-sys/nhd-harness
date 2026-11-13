# Response Speed Benchmark — release receipt (2026-11-08)

## Requested outcome
Measure observed ChatGPT Plus web-response throughput (estimated output tok/s) over multiple samples for later comparison with local AI models. Do not invent a tok/s value from plan/model branding or total conversation-token telemetry.

## Implementation
- New event-driven `browser-extension/chat-health/stream-speed-core.js` plus `stream-speed-observer.js`: observes new user/assistant turns, first visible response, subsequent text changes, and inferred completion; no background DOM polling while idle.
- New `response-speed-background.js`: strict numeric allowlist; durable local `chrome.storage.local` bounded to 2000 samples; best-effort localhost sync. If backend unavailable, store first and export later. Does not read or transmit prompt/answer bodies.
- Updated `manifest.json` to inject scripts only on `https://chatgpt.com/*` without new permissions, and startup injection into existing ChatGPT tabs; `tv-recorder-background.js` imports the new metric-only handler alongside existing NHD/TradingView service worker logic.
- Updated extension options to label model and workload, enable/disable metrics, show count/median, export CSV/JSONL and sync pending samples.
- New `src/response-speed-benchmark.ts` and local-only endpoints in `src/server.ts`: POST `/api/benchmarks/response-speed/sample`; GET `/summary`, `/recent`, `/export.csv`. Canonical JSONL + CSV on D drive.
- Dataset project `D:\NHD Projects\Model Benchmark MCP\ChatGPT Plus UI` with `README.md`, `STANDARD_WORKLOADS.md`, `summarize_speed.py`, header-only CSV.

## Metric caveats
- TTFV is send/UI DOM event to first rendered visible text, not network/model TTFT.
- Estimated tok/s uses `round(visibleChars/4)` divided by observed first-to-last text update duration. This does not expose API usage tokens, proprietary tokenizer or hidden reasoning tokens.
- The UI can buffer/delay output and background-tab throttling corrupts timing. Hidden, single-chunk and low-confidence samples are identified/excluded from valid median.
- User model label is **manual**; model identity and thinking effort cannot be verified via this instrumentation.
- No synthetic data inserted into production CSV/JSONL.

## QA evidence
- All 8 touched JavaScript sources pass `node --check`.
- `tsc --noEmit`: PASS.
- Extension tests: **11/11 PASS** (including real-time observer simulation, no idle polling, strict content privacy allowlist, background-backend offline fallback and preserved TradingView recorder tests).
- Node backend tests: **3/3 PASS** (persist/reload, dedup, estimated speed calculations, invalid input rejection, zero token samples).
- Rebuilt to `.response-speed-stage-20261108`, promoted exactly two compiled backend files to `dist`:
  - `dist/server.js` SHA-256 `165860DCDD939034BDEA3A669C29E958A404C34AB7A5F126B27F8F0E1F1B316B`.
  - `dist/response-speed-benchmark.js` SHA-256 `9AC50EF9D1483124EA970F20DB9DD0CFA090F041E29FAE7B8BD89F98A8944D23`.
- Previous compiled server saved in `deploy-backups/response-speed-20261108/server.js`, receipt `deploy-backups/response-speed-20261108/receipt.json`. All modified extension/server source originals are `.pre-response-speed-20261108.bak` beside originals.
- Production dataset at last readback: **0** valid/real samples, CSV contains only header.
- Current backend HTTP GET new summary route returned HTML SPA fallback (`Content-Type: text/html`), proving the **running server has not loaded the new route**. Source and compiled release are ready but **backend restart is required**.
- Extension has not been reloaded after new manifest/script writes. Browser live sample collection is **not yet verified**.

## Required activation / acceptance
1. Reload the **NHD MCP Cốc Cốc Agent Sensor** in `coccoc://extensions`, or restart Cốc Cốc extension according to its installed workflow. The observer is injected on newly opened ChatGPT pages, or into existing ChatGPT tabs at extension startup.
2. Restart only NHD MCP backend from NHD MCP Control Center when no other task is writing; do not restart Windows or terminate unrelated processes.
3. Open extension options; set `modelLabel` to model actually selected and `workloadLabel` to workload ID. Send a **new** ChatGPT prompt to generate a measurable response.
4. Read `/api/benchmarks/response-speed/summary`, verify `samples>0` and CSV/JSONL size; compare the real UI timing with 1+ local model in later task.
5. If the backend was offline during initial samples, click **Đồng bộ về NHD (ổ D)** from options after restart.
6. No exact tok/s or benchmark success claim until a real sample is logged and reviewed.

## Rollback
Restore original sources from each `.pre-response-speed-20261108.bak` and original compiled server from `deploy-backups/response-speed-20261108/server.js`. No user media, trading engine, Office file, DOM optimization baseline, or browser tabs were changed by this release.
