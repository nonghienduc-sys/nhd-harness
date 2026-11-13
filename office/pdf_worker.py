import base64
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
LOCAL_TESSDATA = ROOT / "runtime" / "tesseract" / "tessdata"


def emit_line(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def find_tesseract():
    candidates = [os.environ.get("NHD_TESSERACT_EXE"), shutil.which("tesseract"), r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    return None


def available_languages():
    if LOCAL_TESSDATA.is_dir():
        return sorted(path.stem for path in LOCAL_TESSDATA.glob("*.traineddata"))
    return []


def configure_pytesseract(pytesseract):
    executable = find_tesseract()
    if not executable:
        raise RuntimeError("Tesseract OCR executable is not installed or discoverable.")
    pytesseract.pytesseract.tesseract_cmd = executable
    if LOCAL_TESSDATA.is_dir():
        os.environ["TESSDATA_PREFIX"] = str(LOCAL_TESSDATA)
    return executable


def status():
    modules = {}
    for name in ("fitz", "PIL", "pytesseract"):
        try:
            __import__(name)
            modules[name] = True
        except Exception:
            modules[name] = False
    executable = find_tesseract()
    languages = available_languages()
    version = None
    if executable:
        try:
            version = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=5).stdout.splitlines()[0].strip()
        except Exception:
            pass
    return {"available": modules.get("fitz", False), "render": modules.get("fitz", False), "ocr": modules.get("fitz", False) and modules.get("PIL", False) and modules.get("pytesseract", False) and bool(executable) and "eng" in languages, "tesseract": executable, "tesseractVersion": version, "tessdata": str(LOCAL_TESSDATA) if LOCAL_TESSDATA.is_dir() else None, "languages": languages, "vietnamese": "vie" in languages, "modules": modules}


def render(payload):
    import fitz
    document = fitz.open(payload["path"])
    try:
        images = []
        for page_number in payload["pages"]:
            if page_number < 1 or page_number > document.page_count:
                continue
            page = document.load_page(page_number - 1)
            scale = min(max(payload.get("maxWidth", 1600), 640) / max(page.rect.width, 1), 4.0)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            data = pixmap.tobytes("png")
            images.append({"page": page_number, "mimeType": "image/png", "data": base64.b64encode(data).decode("ascii"), "width": pixmap.width, "height": pixmap.height})
        return {"path": payload["path"], "pageCount": document.page_count, "images": images}
    finally:
        document.close()


def ocr(payload):
    import fitz
    import pytesseract
    from PIL import Image
    executable = configure_pytesseract(pytesseract)
    languages = available_languages()
    language = payload.get("language", "vie+eng")
    requested = [part.strip() for part in language.split("+") if part.strip()]
    missing = [part for part in requested if part not in languages]
    if missing:
        raise RuntimeError(f"Missing Tesseract language data: {', '.join(missing)}")
    document = fitz.open(payload["path"])
    try:
        pages = []
        for page_number in payload["pages"]:
            if page_number < 1 or page_number > document.page_count:
                continue
            page = document.load_page(page_number - 1)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(2.5, 2.5), alpha=False)
            image = Image.open(io.BytesIO(pixmap.tobytes("png")))
            data = pytesseract.image_to_data(image, lang=language, output_type=pytesseract.Output.DICT)
            words = [text.strip() for text in data.get("text", []) if text and text.strip()]
            confidences = []
            for value in data.get("conf", []):
                try:
                    score = float(value)
                    if score >= 0: confidences.append(score)
                except Exception:
                    pass
            pages.append({"page": page_number, "text": " ".join(words), "confidence": round(sum(confidences) / len(confidences), 2) if confidences else None})
        return {"path": payload["path"], "language": language, "engine": "tesseract", "executable": executable, "tessdata": str(LOCAL_TESSDATA), "pages": pages}
    finally:
        document.close()


def handle(payload):
    action = payload.get("action")
    if action == "status": return status()
    if action == "render": return render(payload)
    if action == "ocr": return ocr(payload)
    raise RuntimeError("Unknown PDF worker action.")


def persistent_main():
    emit_line({"kind": "ready", "worker": "pdf", "pid": os.getpid(), "version": "2"})
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
