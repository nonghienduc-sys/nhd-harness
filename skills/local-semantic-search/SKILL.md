---
name: local-semantic-search
description: Build a local hybrid retrieval store with FastEmbed, sqlite-vec and SQLite FTS5 for cross-document recall. Supports vector search, BM25-style lexical search, Reciprocal Rank Fusion, provenance locators and source verification without a hosted vector database.
---

# Local Hybrid Semantic Search

## Runtime
- Isolated venv: `runtime/semantic-memory-venv`
- `fastembed==0.8.1`
- `sqlite-vec==0.1.9`
- SQLite FTS5 for lexical retrieval
- Helper: `skills/local-semantic-search/scripts/semantic_store.py`
- Default multilingual embedding model: `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`

## Scope
This is a retrieval layer, not permission to ingest everything on the workstation. Add only user-approved documents/chunks. Do not index secrets, credentials, browser profiles, private keys or blocked paths.

## Retrieval modes
- `search`: vector-only compatibility mode.
- `hybrid`: vector candidates + FTS5/BM25 lexical candidates fused with Reciprocal Rank Fusion (RRF).
- Hybrid results preserve `source`, `title`, `page`, `section`, `locator`, metadata, vector rank/distance and lexical rank/BM25 score.

## Workflow
1. Normalize documents first with MarkItDown or PyMuPDF4LLM.
2. Chunk by logical heading/article/section rather than arbitrary tiny fragments.
3. When adding a chunk, preserve a stable locator such as `file#page=12`, `docx:article-29`, or a section ID.
4. Prefer `hybrid` for legal, administrative, policy, research and exact-name queries; use vector-only search for semantic exploration.
5. Treat retrieval as candidate selection; verify high-impact facts, amounts, dates and legal citations against the original source.
6. Keep the SQLite store local. `sqlite-vec` is pre-v1; retain source text so the vector index can be rebuilt.

## Examples
```powershell
$py="runtime\semantic-memory-venv\Scripts\python.exe"
& $py "skills\local-semantic-search\scripts\semantic_store.py" add --db "runtime\memory\semantic.db" --source "report.pdf" --title "Báo cáo" --page 12 --section "2.3" --locator "report.pdf#page=12" --text "Nội dung cần ghi nhớ"
& $py "skills\local-semantic-search\scripts\semantic_store.py" hybrid --db "runtime\memory\semantic.db" --query "kinh phí dự án chuỗi giá trị" --limit 8
```

## Quality checks
- `status` must report equal `chunks` and `fts_chunks`.
- Exact terms/names should be recoverable through the lexical leg even when embeddings are weak.
- Semantic paraphrases should remain recoverable through the vector leg.
- Never cite the hybrid score as evidence; cite the original locator/source.
