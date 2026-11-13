---
name: scientific-research-slide-style
description: Use when creating, redesigning, or auditing PowerPoint or slide decks for academic research, scientific proposals, thesis-style talks, medical/lab research, technology research, or space/science topics where the user wants the look of the downloaded research presentation templates. The skill includes reference PPTX assets, contact sheets, style rules, and a PPTX audit script for recreating the same geometric, modern research slide language.
metadata:
  short-description: Design research slides from reference templates
---

# Scientific Research Slide Style

## Quick Use

Use this skill when the user wants a scientific research deck that looks like the downloaded template set. For the closest match, copy one of the reference PPTX files from `assets/reference-pptx/` and replace content while preserving slide size, theme, masters, decorative shapes, cards, icon rhythm, and title scale.

Read `references/template-map.md` to choose the right source deck. Read `references/style-system.md` when building new slides, merging styles, or auditing visual fidelity.

## Workflow

1. Pick a template track before editing:
   - Dark tech scientific: scientific, space, technology, engineering, lab instrumentation.
   - Bright research: general research, methods, objectives, findings, data summaries.
   - Medical pastel: health, hospital, public health, collaboration, problem statement.
   - Editorial proposal: research proposal, qualitative study, academic report, muted formal tone.
2. Start from a reference PPTX whenever the user asks for an exact or near-exact look. Do not start from a blank deck unless no source deck fits.
3. Preserve the 20 x 11.25 inch 16:9 canvas. Keep master/theme colors and typography unless the user explicitly asks for a new brand.
4. Build each slide around one visual idea: a large title, one dominant shape/image placeholder, and short blocks of body copy.
5. Use the template's native decorative system instead of generic clip art: ellipses, rounded rectangles, pale blobs, molecule/dot patterns, plus signs, circuitry, hexagons, timelines, and compact icon labels.
6. Keep text short. These decks rely on large white space and visual rhythm; avoid dense paragraphs except in proposal/editorial slides.
7. After generating or editing a deck, render slides or inspect a contact sheet. Then run `scripts/audit_pptx_style.py` on the candidate PPTX and fix major warnings.

## Assets

- `assets/reference-pptx/`: six non-animated PowerPoint reference decks copied from the downloaded template set.
- `assets/contact-sheets/`: rendered preview sheets for fast visual comparison.
- `scripts/audit_pptx_style.py`: OOXML-based style audit for slide size, color/font/shape profile, and likely mismatches.

## Fidelity Rules

- Exact-match request: clone layouts from the closest reference deck and replace only text, icons, images, numbers, and chart data.
- Same-family request: combine slide types from multiple reference decks, but keep one typography/palette family for the whole output.
- Avoid adding unrelated stock aesthetics, big gradients, 3D art, heavy shadows, or marketing hero layouts.
- Do not erase decorative shapes unless they conflict with the user's content. They are part of the style.
- Final output should feel like a template-native deck, not content pasted into a theme.

## Final Check

Run:

```bash
python scripts/audit_pptx_style.py path/to/deck.pptx
```

Also inspect rendered slides for title scale, crop/framing, overlaps, tiny text, and whether each slide still has the reference system's geometric structure.
