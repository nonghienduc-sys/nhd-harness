---
name: ocr-vietnamese-paddleocr
description: OCR Vietnamese and multilingual scanned images/PDF pages locally with PaddleOCR, used when native text extraction fails or Tesseract is unavailable.
---

# Vietnamese OCR - PaddleOCR

## Runtime
- Isolated venv: `runtime/paddleocr-venv`
- `paddleocr==3.7.0`
- `paddlepaddle==3.2.2`
- Helper: `skills/ocr-vietnamese-paddleocr/scripts/ocr_file.py`

## Compatibility
- Verified runtime pair on this Windows CPU environment: `paddleocr==3.7.0`, `paddlepaddle==3.2.2`, `numpy==2.3.5`.
- PaddlePaddle 3.3.1 hit a oneDNN/PIR runtime regression during real OCR smoke testing, so keep 3.2.2 pinned until upstream compatibility is re-verified.

## When to use
Use only after native text extraction fails or the source is image/scanned. OCR is probabilistic: never silently replace critical names, dates, amounts or legal citations without checking the page image.

## Workflow
1. Prefer built-in vision/native PDF text first.
2. For Vietnamese scans, use `lang=vi` with the current PP-OCR pipeline.
3. First use may download OCR models; cache them locally and reuse them.
4. Save machine-readable OCR output to a derived output folder.
5. For tables and complex pages, pair OCR with PyMuPDF4LLM/layout inspection.
6. Visually verify low-confidence or high-impact fields before using them in reports.

## Example
```powershell
& "runtime\paddleocr-venv\Scripts\python.exe" "skills\ocr-vietnamese-paddleocr\scripts\ocr_file.py" --input "scan.png" --output "output\ocr\scan"
```

## Core integration
- pdf_document action=ocr now uses the core OCR dispatcher.
- engine=auto prefers PaddleOCR and falls back to Tesseract when available.
- engine=paddleocr or engine=tesseract can be used to force one engine for diagnostics.
- OCR results expose engine, requestedEngine, fallbackUsed, warnings, page confidence, and line-level confidence/boxes for PaddleOCR.

