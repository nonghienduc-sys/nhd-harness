# Context Orchestrator

Use `document_context` after indexing a DOCX. It returns a bounded context pack rather than the complete document.

The planner ranks the primary logical node, confirmed decisions, explicit graph dependencies, hierarchy context, verified decisions, local FTS matches, then proposed/unresolved items and source metadata. It estimates tokens as characters divided by four and defaults to a 24,000-token budget. It returns `budget`, `usedTokens`, `remainingTokens`, `omittedCount`, `truncated` and warnings, with the invariant `usedTokens <= budget`. It trims only complete semantic blocks; clauses and decisions are not split. Large evidence stays in project resources and is retrieved on demand.

Skill routing remains advisory. Relevant skill rules may be selected by the caller, but full `SKILL.md` files are not injected automatically.
