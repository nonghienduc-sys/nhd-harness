#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="Fast local video/audio transcription for NHD MCP.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--language", default="")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(f"faster_whisper unavailable: {exc}", file=sys.stderr)
        return 2

    source = Path(args.input)
    if not source.exists():
        print("Input media file was not found.", file=sys.stderr)
        return 2

    device = args.device
    if device == "auto":
        device = "cpu"
        try:
            import torch
            if torch.cuda.is_available():
                device = "cuda"
        except Exception:
            pass

    compute_type = "float16" if device == "cuda" else "int8"
    cpu_threads = max(1, min(12, (os.cpu_count() or 4) - 1))
    try:
        model = WhisperModel(
            args.model,
            device=device,
            compute_type=compute_type,
            cpu_threads=cpu_threads,
            num_workers=1,
        )
        segments, info = model.transcribe(
            str(source),
            language=args.language.strip() or None,
            beam_size=1,
            best_of=1,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=350),
            condition_on_previous_text=False,
            word_timestamps=False,
            temperature=0.0,
        )
        rows = []
        for segment in segments:
            text = str(segment.text or "").strip()
            if not text:
                continue
            rows.append({
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": text,
            })
        payload = {
            "engine": "faster-whisper",
            "model": args.model,
            "device": device,
            "compute_type": compute_type,
            "language": getattr(info, "language", None),
            "language_probability": getattr(info, "language_probability", None),
            "duration": getattr(info, "duration", None),
            "segments": rows,
        }
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "ok": True,
            "segments": len(rows),
            "language": payload["language"],
            "model": args.model,
            "device": device,
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"Transcription failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
