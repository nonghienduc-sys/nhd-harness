import contextlib
import json
import os
import sys
import time

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ENGINE_CACHE = {}


def emit_line(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def status():
    try:
        with contextlib.redirect_stdout(sys.stderr):
            import numpy
            import paddle
            import paddleocr
        return {"available": True, "engine": "paddleocr", "paddleocr": getattr(paddleocr, "__version__", None), "paddle": getattr(paddle, "__version__", None), "numpy": getattr(numpy, "__version__", None), "cachedLanguages": sorted(ENGINE_CACHE.keys())}
    except Exception as error:
        return {"available": False, "engine": "paddleocr", "error": str(error), "cachedLanguages": sorted(ENGINE_CACHE.keys())}


def plain(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    return value


def get_engine(language):
    engine = ENGINE_CACHE.get(language)
    if engine is not None:
        return engine, False
    with contextlib.redirect_stdout(sys.stderr):
        from paddleocr import PaddleOCR
        engine = PaddleOCR(lang=language, use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False)
    # Bound memory: Vietnamese and English are the expected active models. If callers
    # request more, retain only the two most recently inserted languages.
    ENGINE_CACHE[language] = engine
    while len(ENGINE_CACHE) > 2:
        oldest = next(iter(ENGINE_CACHE.keys()))
        if oldest == language and len(ENGINE_CACHE) > 1:
            oldest = next(key for key in ENGINE_CACHE.keys() if key != language)
        ENGINE_CACHE.pop(oldest, None)
    return engine, True


def ocr(payload):
    language = payload.get("language") or "vi"
    items = payload.get("items") or []
    if not items:
        raise RuntimeError("No rendered page images were provided to PaddleOCR.")
    load_started = time.perf_counter()
    engine, loaded = get_engine(language)
    model_load_ms = round((time.perf_counter() - load_started) * 1000.0, 3) if loaded else 0.0
    pages = []
    for item in items:
        with contextlib.redirect_stdout(sys.stderr):
            results = engine.predict(item["path"])
        texts, scores, lines = [], [], []
        for result in results:
            try:
                data = result.json
                if isinstance(data, dict) and isinstance(data.get("res"), dict):
                    data = data["res"]
            except Exception:
                data = result if isinstance(result, dict) else {}
            rec_texts = list(data.get("rec_texts") or [])
            rec_scores = list(data.get("rec_scores") or [])
            rec_boxes = list(data.get("rec_boxes") or [])
            for index, text in enumerate(rec_texts):
                text = str(text).strip()
                if not text:
                    continue
                raw_score = rec_scores[index] if index < len(rec_scores) else None
                try:
                    score = float(raw_score) * 100.0 if raw_score is not None else None
                except Exception:
                    score = None
                box = plain(rec_boxes[index]) if index < len(rec_boxes) else None
                texts.append(text)
                if score is not None: scores.append(score)
                line = {"text": text, "confidence": round(score, 2) if score is not None else None}
                if box is not None: line["box"] = box
                lines.append(line)
        pages.append({"page": int(item["page"]), "text": "\n".join(texts), "confidence": round(sum(scores) / len(scores), 2) if scores else None, "lines": lines})
    return {"engine": "paddleocr", "language": language, "modelLoadedThisRequest": loaded, "modelLoadMs": model_load_ms, "cachedLanguages": sorted(ENGINE_CACHE.keys()), "pages": pages}


def handle(payload):
    action = payload.get("action")
    if action == "status": return status()
    if action == "ocr": return ocr(payload)
    raise RuntimeError("Unknown PaddleOCR worker action.")


def persistent_main():
    emit_line({"kind": "ready", "worker": "paddleocr", "pid": os.getpid(), "version": "2"})
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw: continue
        request_id = None
        try:
            message = json.loads(raw)
            request_id = str(message.get("id") or "")
            started = time.perf_counter()
            result = handle(message.get("payload") or {})
            if isinstance(result, dict): result.setdefault("workerMs", round((time.perf_counter() - started) * 1000.0, 3))
            emit_line({"kind": "response", "id": request_id, "ok": True, "result": result})
        except Exception as error:
            emit_line({"kind": "response", "id": request_id, "ok": False, "error": str(error)})


def main():
    if "--persistent" in sys.argv:
        persistent_main(); return
    payload = json.loads(sys.stdin.read() or "{}")
    sys.stdout.write(json.dumps(handle(payload), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(1)
