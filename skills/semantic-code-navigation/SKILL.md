---
name: semantic-code-navigation
description: Navigate TypeScript code semantically at symbol/definition/reference level using the TypeScript language service already installed in the MCP project. Use for impact analysis, locating definitions, reference tracing and safe code-change planning without adding another MCP server.
---

# Semantic Code Navigation

This skill brings the core Serena-style benefit—symbol-aware code navigation—into the existing NHD MCP without installing a second MCP server.

## Runtime
- Uses the project's existing `typescript` package and `tsconfig.json`.
- Read-only helper: `skills/semantic-code-navigation/scripts/ts_semantic.mjs`.
- No network access and no file mutation.

## Commands
```powershell
node skills/semantic-code-navigation/scripts/ts_semantic.mjs find --project D:\ChatGPT-Workstation-MCP --name RuntimeIdentityService
node skills/semantic-code-navigation/scripts/ts_semantic.mjs references --project D:\ChatGPT-Workstation-MCP --name RuntimeIdentityService --limit 100
node skills/semantic-code-navigation/scripts/ts_semantic.mjs outline --project D:\ChatGPT-Workstation-MCP --file src/runtime-identity.ts
node skills/semantic-code-navigation/scripts/ts_semantic.mjs quickinfo --project D:\ChatGPT-Workstation-MCP --file src/runtime-identity.ts --line 115 --column 14
```

## Workflow
1. Use `find` before text search when the target is a known TypeScript symbol.
2. Use `references` before changing public interfaces, services, registries or shared utility functions.
3. Use `outline` to understand a large file without reading it in full.
4. Use `definition`/`quickinfo` when a call site or imported symbol is ambiguous.
5. This skill is advisory/read-only. Actual edits still use normal NHD preview/apply and regression-test gates.

## Upstream architectural reference
- Serena: https://github.com/oraios/serena

NHD intentionally reuses the TypeScript language service already present instead of installing Serena's separate Python/LSP runtime for this TypeScript-heavy codebase.
