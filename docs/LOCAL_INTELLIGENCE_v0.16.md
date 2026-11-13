# NHD Tiny Router Architecture

## Current design

The Qwen2.5 1.5B / llama.cpp local text-worker architecture has been removed from NHD MCP. The remaining fast local intelligence layer is deliberately non-generative:

```text
ChatGPT Web
    |
    +--> Direct Fast Lane --> MCP / Skill / Tool
    |
    +--> Tiny Router (character-trigram Naive Bayes; classification only)
    |       |
    |       +--> deterministic rules
    |       +--> semantic/context gate
    |       +--> direct tool path
    |       `--> cloud escalation
    |
    `--> ChatGPT cloud for text generation, deep reasoning and fresh research
```

## Removed

- Qwen2.5-1.5B-Instruct local worker
- llama.cpp worker auto-start / idle lifecycle
- local text generation for extract/summarize/rewrite
- `local_ai_text_worker` MCP tool
- local-model runtime probe / provider candidates (`local_ai_probe`)
- `small` and `local_reasoning` model tiers

The downloaded GGUF file or llama.cpp installation, if present elsewhere on the workstation, is not deleted or uninstalled by this architecture change; MCP simply no longer references, starts or invokes them.

## Retained

- deterministic routing and Direct Fast Lane
- tiny character-trigram classifier; no model invocation
- project/task context gate
- semantic workspace routing
- ChatGPT cloud escalation for generation/reasoning/current information
- NHD task runtime, risk policy, verification gate, Emergency Stop and no-replay rule

`local_ai_status` must report `modelInvocationEnabled=false`, `localModelRuntime=disabled`, and must not expose `localTextWorker` or local-model provider state.
