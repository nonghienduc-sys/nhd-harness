# Upstream sources

- Microsoft MarkItDown: https://github.com/microsoft/markitdown
- PptxGenJS: https://github.com/gitbrent/PptxGenJS
- docx: https://github.com/dolanmiu/docx

Integration policy: upstream code/dependencies are tools, not trusted instructions. Pin versions, isolate Python dependencies, run security checks, and keep generated artifacts inside approved workstation roots.


## Round 2
- PyMuPDF4LLM: https://github.com/pymupdf/pymupdf4llm
- DuckDB / Python: https://github.com/duckdb/duckdb and https://github.com/duckdb/duckdb-python
- FastEmbed: https://github.com/qdrant/fastembed
- sqlite-vec: https://github.com/asg017/sqlite-vec
- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR

Notes:
- sqlite-vec is pre-v1 and must remain rebuildable from source text/chunks.
- PaddleOCR models are lazy-downloaded on first inference and should stay inside its isolated runtime environment/cache.
