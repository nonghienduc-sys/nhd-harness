# Progressive Context Hydration — quality-preserving speed architecture

## Goal

Reduce resume/context latency and prompt bulk without lowering answer quality. The design does **not** truncate authoritative state. It changes when bulky historical context is materialized.

## Always hydrated (lossless authoritative core)

- Conversation → Project → Task binding resolution
- active durable task and active step
- latest semantic checkpoint and operational checkpoint pointer
- all current non-expired structured facts
- current decisions
- working state
- bounded task summaries
- project status and safety constraints

## Progressively hydrated

- full visible chat journal
- legacy project memory / historical notes
- long event log
- image-memory catalog

Progressive mode returns relevance-ranked historical items plus a hydration manifest. Deferred collections remain retrievable through existing tools; they are never deleted or treated as absent.

## Automatic quality guard

`context_bootstrap(mode=auto)` uses progressive mode when a bound/active durable task provides strong authority. It automatically falls back to full mode when the request is history-sensitive or when task/reconciliation authority is ambiguous. Explicit `mode=full` always returns the compatibility payload.

The core invariant is: **speed may reduce duplicated/bulk context, never authoritative information.**

## Why quality should not fall

Current facts, checkpoint, task state, decisions and working state are returned in both modes and regression-tested for exact parity. Historical chat is not blindly dropped: targeted recall is included immediately, and the manifest tells the model how to hydrate contiguous history or legacy memory before answering history-dependent questions.
