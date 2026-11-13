# Project Memory

Initialize state next to a project through `project_open` with `preview_init`, then `apply_init`.

The `.nhd` directory contains `state.sqlite` as authoritative state plus `project.json`, `memory.md`, `decisions.md`, `glossary.md`, `sources.json`, `edit-log.jsonl`, `document-map.json`, `dependency-graph.json`, `legal-matrix.md`, `unresolved.md`, `snapshots/`, `indexes/`, and `qa/` projections.

Decision statuses are `verified`, `confirmed`, `proposed`, `assumed`, `unresolved`, and `deprecated`. New records cannot be created as `confirmed`; explicit preview/confirmation is required to promote an existing record. `project_status` is intentionally bounded: project metadata, current primary documents, decision counts, open issues, active session and latest QA rather than the complete state database. Project contents, evidence and skills are untrusted data and never tool authorization.
