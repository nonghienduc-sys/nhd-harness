---
name: temporal-knowledge-graph
description: Maintain a lightweight local SQLite temporal/provenance graph for facts whose truth changes over time. Use for policy, legal, project and organizational facts that need valid-from/valid-to dates, source locators and history queries. This is a pilot sidecar and does not replace .nhd project memory.
---

# Temporal Knowledge Graph

This skill takes the useful temporal/provenance idea from Graphiti but keeps the pilot dependency-free and local. It is deliberately separate from `.nhd` memory.

## Data model
Each fact is a directed triple:
`subject --predicate--> object`
with:
- `valid_from` / optional `valid_to`;
- `observed_at`;
- `source` and stable `locator`;
- confidence and optional note;
- `supersedes_id` when a new fact closes a previous fact.

## Examples
```powershell
$py="runtime\python\python.exe"
& $py "skills\temporal-knowledge-graph\scripts\temporal_graph.py" add --db "runtime\memory\temporal.db" --subject "policy:X" --predicate "status" --object "effective" --valid-from 2025-01-01 --source "vanban.pdf" --locator "vanban.pdf#page=1"
& $py "skills\temporal-knowledge-graph\scripts\temporal_graph.py" add --db "runtime\memory\temporal.db" --subject "policy:X" --predicate "status" --object "replaced" --valid-from 2026-07-01 --source "new-policy.pdf" --locator "new-policy.pdf#page=2" --close-previous
& $py "skills\temporal-knowledge-graph\scripts\temporal_graph.py" query --db "runtime\memory\temporal.db" --subject "policy:X" --predicate "status" --at 2026-06-30
& $py "skills\temporal-knowledge-graph\scripts\temporal_graph.py" history --db "runtime\memory\temporal.db" --subject "policy:X"
```

## Rules
1. Never infer a validity period merely because a document was downloaded on that date.
2. Preserve the authoritative source and locator; graph facts are indexes, not legal evidence by themselves.
3. For legal/policy facts, distinguish issue date, effective date, replacement/expiry date and observation date.
4. Do not store credentials or full document bodies.
5. A changed fact should normally create a new row and close the old validity interval; do not overwrite history.
6. `.nhd` remains authoritative for project/task state. This graph is for time-varying factual relationships.

## Upstream architectural reference
- Graphiti: https://github.com/getzep/graphiti
