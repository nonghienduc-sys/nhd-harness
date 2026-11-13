import argparse, json
from pathlib import Path
import pymupdf4llm

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--format", choices=["markdown", "json", "text"], default="markdown")
    ap.add_argument("--page-chunks", action="store_true")
    args = ap.parse_args()
    src = Path(args.input).resolve()
    dst = Path(args.output).resolve()
    if not src.is_file():
        raise SystemExit(f"Input not found: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    if args.format == "markdown":
        data = pymupdf4llm.to_markdown(str(src), page_chunks=args.page_chunks)
    elif args.format == "json":
        data = pymupdf4llm.to_json(str(src))
    else:
        data = pymupdf4llm.to_text(str(src))
    if not isinstance(data, str):
        data = json.dumps(data, ensure_ascii=False, indent=2)
    dst.write_text(data, encoding="utf-8")
    print(json.dumps({"ok": True, "input": str(src), "output": str(dst), "chars": len(data)}, ensure_ascii=False))

if __name__ == "__main__":
    main()
