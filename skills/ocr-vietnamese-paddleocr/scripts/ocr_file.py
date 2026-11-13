import argparse, json
from pathlib import Path
from paddleocr import PaddleOCR

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--lang", default="vi")
    args = ap.parse_args()
    src = Path(args.input).resolve()
    out = Path(args.output).resolve()
    if not src.exists():
        raise SystemExit(f"Input not found: {src}")
    out.mkdir(parents=True, exist_ok=True)
    ocr = PaddleOCR(
        lang=args.lang,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
    )
    results = ocr.predict(str(src))
    saved = 0
    for i, res in enumerate(results):
        target = out / f"page-{i+1:04d}"
        target.mkdir(parents=True, exist_ok=True)
        try:
            res.save_to_json(str(target))
        except Exception:
            pass
        try:
            res.save_to_img(str(target))
        except Exception:
            pass
        saved += 1
    print(json.dumps({"ok": True, "input": str(src), "output": str(out), "items": saved, "lang": args.lang}, ensure_ascii=False))

if __name__ == "__main__":
    main()
