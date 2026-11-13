# Migration from v0.2.2 to v0.3.0

No global database migration is required. Existing OAuth tokens, global file index, pending-action flow, tunnel configuration and dashboard routes are unchanged.

Project state is opt-in. For each project, initialize `<root>.nhd` through the confirmation-protected `project_open` flow, then run `document_index` for each primary DOCX. Legacy `office_preview_edit` remains available for compatibility; use `document_edit_preview` for structured DOCX section editing.

Do not manually edit `state.sqlite` while an MCP request is active. Readable projections may be inspected, but changes should go through MCP so audit, hash and conflict protections remain correct.
