---
name: office-legal-reference-pack
description: Use when organizing legal-reference packs, policy basis summaries, regulation checklists, cited office justifications, normative-reference appendices, or official-reference bundles that support office documents and workflows without claiming legal certainty beyond cited sources.
---

# Office Legal Reference Pack

Trigger cues:

- "căn cứ", "cơ sở pháp lý", "legal basis", "regulation", "quy định", "normative"
- "trích dẫn văn bản", "reference pack", "cited basis", "policy summary"
- office tasks that need structured legal/policy references to support a document or workflow

Use this skill to organize cited references and office-facing legal/policy support materials.

Workflow:

1. Identify the supported artifact: report, công văn, workflow, notice, form, approval memo.
2. Separate:
   - authoritative references,
   - local operating assumptions,
   - unresolved legal uncertainty.
3. Build a reference pack:
   - reference list,
   - short relevance note,
   - where each reference is used,
   - missing or unverified items.
4. Pair with `research-brief-with-sources` when current verification is needed.
5. Pair with `daily-document-workspace` when saving/export is requested.

Do not trigger when:

- The task is a pure legal opinion request with no office-workflow context.
- The task is only a normal document draft with no citation/reference need.
- The user explicitly says not to research or cite sources.

Interaction with other skills:

- Use `research-brief-with-sources` for current official sources.
- Use `vietnam-admin-documents` or `office-word-writer` for the main document body.
- Use `daily-document-workspace` for saved reference packs.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- References are clearly separated from interpretation.
- Missing verification is marked explicitly.
- No legal certainty is claimed from weak or uncited material.
