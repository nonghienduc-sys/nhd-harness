# Document Editing

`document_index` creates chapters, articles, clauses and independent paragraph nodes from DOCX OOXML. Multiple documents retain their own logical namespace. `document_edit_preview` accepts structured blocks and creates a one-time confirmation. `document_edit_apply` validates the source hash, produces and validates a temporary DOCX/map, backs up the DOCX, atomically replaces it, commits the map, and restores the original when the map commit fails.

Formatting is copied from the original article heading and body paragraph separately. This avoids broad XML replacement and prevents body text from inheriting heading bold, keep-with-next or indentation. If the anchor cannot be resolved safely, apply fails and requires reindexing.

Range resolution is kind-aware: a paragraph edits one paragraph; a clause stops before the next sibling clause or article/chapter boundary; an article stops before the next article/chapter; a chapter stops before the next chapter. Anchor resolution uses `w14:paraId`, normalized text and fingerprints; an unresolved anchor fails rather than editing an uncertain range.

The current v0.3.1 live-Word path remains conservative: use closed-file semantic editing for reliable unattended work. An open unsaved Word document must not be overwritten; future COM live-edit support will inspect its active path and saved state before it can apply a transaction.
