#!/usr/bin/env python3
"""Advisory linter for natural cinematic image/video prompts.

No external dependencies. The score is heuristic; the findings are more useful than
the numeric value. This tool checks prompt specificity and common contradiction/slop
patterns, not whether media was AI-generated.
"""

from __future__ import annotations
import argparse
import json
import re
from pathlib import Path

PRESTIGE = [
    "masterpiece", "best quality", "award winning", "stunning", "epic",
    "ultra detailed", "ultra-detailed", "8k", "16k", "insanely detailed",
]
CAMERA = [
    "wide shot", "medium shot", "close-up", "close up", "macro", "eye-level",
    "eye level", "low angle", "high angle", "over-the-shoulder", "over the shoulder",
    "24mm", "28mm", "35mm", "50mm", "85mm", "telephoto", "wide-angle",
    "wide angle", "dolly", "crane", "tripod", "handheld", "pan ", "tilt ",
    "tracking shot", "locked camera", "static camera",
]
LIGHT = [
    "sunlight", "overcast", "key light", "backlight", "side light", "soft light",
    "hard light", "practical light", "bounce light", "ambient fill", "golden hour",
    "blue hour", "spotlight", "moonlight", "window light", "light spill",
]
PHYSICS = [
    "contact", "weight", "gravity", "wind", "motion blur", "reflection", "roughness",
    "fur", "fibers", "fabric", "dust", "mist", "haze", "wet", "mud", "shadow",
    "inertia", "foot", "hoof", "paw", "ground",
]
IMPERFECTION = [
    "grain", "halation", "lens softness", "edge falloff", "micro-sway",
    "micro sway", "occlusion", "asymmetry", "wear", "scratches", "exposure variation",
    "motion blur", "restrained saturation", "uneven",
]
PRESERVE = [
    "preserve", "keep exact", "remain unchanged", "do not change", "visual anchor",
    "identity", "continuity", "reference image", "source image",
]
MOTION = [
    "moves", "walks", "runs", "turns", "looks", "breathes", "sways", "flies",
    "rises", "falls", "camera", "dolly", "pan", "tilt", "tracking", "handheld",
]
EXCLUSION = [
    "avoid", "no ", "without ", "do not", "must not",
]

CONTRADICTIONS = [
    (r"\b(static|locked) camera\b", r"\bhandheld\b", "static/locked camera conflicts with handheld"),
    (r"\bshallow (depth of field|dof)\b", r"\beverything in focus\b", "shallow depth of field conflicts with everything in focus"),
    (r"\bno motion blur\b", r"\b(fast|rapid|sprinting|whip pan)\b", "fast motion plus 'no motion blur' may look synthetic"),
    (r"\bperfect symmetry\b", r"\b(asymmetry|off-center|off centre)\b", "perfect symmetry conflicts with asymmetric composition"),
]


def contains_any(text: str, phrases: list[str]) -> bool:
    return any(p in text for p in phrases)


def count_any(text: str, phrases: list[str]) -> int:
    return sum(1 for p in phrases if p in text)


def lint(prompt: str, mode: str) -> dict:
    text = " ".join(prompt.lower().split())
    findings: list[dict] = []
    score = 100

    def add(level: str, code: str, message: str, penalty: int = 0):
        nonlocal score
        findings.append({"level": level, "code": code, "message": message})
        score -= penalty

    if len(text) < 80:
        add("warning", "too-short", "Prompt is very short; it may not define enough capture/physics information.", 12)

    if not contains_any(text, CAMERA):
        add("warning", "camera-unspecified", "No concrete framing/lens/camera behavior detected.", 14)

    if not contains_any(text, LIGHT):
        add("warning", "light-unspecified", "No motivated light source or lighting behavior detected.", 10)

    if not contains_any(text, PHYSICS):
        add("warning", "physics-thin", "Little physical/material/contact evidence detected.", 12)

    if not contains_any(text, IMPERFECTION):
        add("info", "imperfection-optional", "No restrained capture imperfection detected; consider one if naturalism is a goal.", 4)

    prestige_count = count_any(text, PRESTIGE)
    if prestige_count >= 3:
        add("warning", "adjective-soup", f"Detected {prestige_count} generic prestige/detail terms; replace most with observable camera/material cues.", 12)
    elif prestige_count:
        add("info", "prestige-term", "Generic prestige wording detected; keep only if it adds meaning.", 2)

    if "cinematic" in text and not contains_any(text, CAMERA):
        add("warning", "cinematic-without-camera", "'Cinematic' is present without concrete cinematography.", 8)

    if "add noise" in text and count_any(text, IMPERFECTION) <= 1:
        add("warning", "noise-only", "Noise alone is not a naturalism strategy; add motivated camera/material/lighting cues.", 8)

    if mode in {"video", "i2v"}:
        if not contains_any(text, MOTION):
            add("warning", "motion-unspecified", "Video prompt does not clearly define temporal motion.", 14)
        moves = count_any(text, ["dolly", "crane", "pan ", "tilt ", "tracking", "handheld", "zoom", "orbit"])
        if moves >= 3:
            add("warning", "camera-overload", f"Detected {moves} camera-movement cues; short generations usually benefit from one dominant move.", 10)

    if mode == "i2v" and not contains_any(text, PRESERVE):
        add("warning", "source-lock-missing", "Image-to-video prompt should explicitly preserve the source image/identity/composition anchors.", 16)

    if not contains_any(text, EXCLUSION):
        add("info", "no-exclusions", "No concise failure-prevention constraint detected.", 3)

    for a, b, message in CONTRADICTIONS:
        if re.search(a, text) and re.search(b, text):
            add("error", "contradiction", message, 18)

    score = max(0, min(100, score))
    grade = "strong" if score >= 85 else "usable" if score >= 70 else "revise"
    return {"mode": mode, "score": score, "grade": grade, "findings": findings}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["image", "video", "i2v"], required=True)
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--prompt")
    src.add_argument("--file")
    args = parser.parse_args()

    prompt = args.prompt if args.prompt is not None else Path(args.file).read_text(encoding="utf-8")
    result = lint(prompt, args.mode)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["grade"] != "revise" else 1


if __name__ == "__main__":
    raise SystemExit(main())
