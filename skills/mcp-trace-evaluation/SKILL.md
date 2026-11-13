---
name: mcp-trace-evaluation
description: Evaluate NHD MCP tool-call telemetry using local OpenInference-compatible TOOL spans. Tracks latency, result size, errors, ambiguous verification and task-run correlation without storing raw prompts, raw tool inputs, raw tool outputs or sending traces to a remote collector.
---

# MCP Trace Evaluation

This skill adopts the useful parts of Phoenix/OpenTelemetry/OpenInference observability while keeping NHD telemetry local and metadata-only.

## Core behavior
- Every MCP tool call receives a 32-hex trace ID and 16-hex span ID.
- Span kind is `TOOL` and the semantic attribute `openinference.span.kind=TOOL` is emitted in the in-memory trace view.
- When an input contains a valid `task_run_id`, the span stores only that durable-task identifier for correlation.
- The system records latency, approximate result size/token size, pagination/truncation, error state and verification state.
- It never stores raw tool input/output content in telemetry and has no remote exporter enabled by default.

## Evaluation signals
Use `resultTelemetry` from workstation health/dashboard to inspect:
- p50/p95 latency;
- p50/p95 result size;
- large/very-large payloads;
- error and ambiguous-verification rates;
- pagination/truncation counts;
- per-call OpenInference-compatible span metadata.

## Safety
Tracing is observational only. It never grants authorization, replays a call, modifies a result, or exports data to a third party.

## Upstream architectural references
- Arize Phoenix: https://github.com/Arize-ai/phoenix
- OpenInference: https://github.com/Arize-ai/openinference
