---
name: pptxgenjs-authoring
description: Create and regenerate PowerPoint .pptx files programmatically with PptxGenJS, then verify the result visually and with PowerPoint when available.
---

# PptxGenJS Authoring

## Purpose
Use for repeatable PowerPoint generation from structured data, reports, research results, charts, tables, images and templates when PowerPoint does not need to be open during generation.

## Runtime
- Node package: `pptxgenjs`
- Upstream: PptxGenJS
- Installed target: 4.0.1

## Security gate
The upstream 4.0.1 package declares `image-size` 1.x even though the current dist bundle does not use it. Keep this skill disabled until the dependency override/audit smoke test passes. Do not process untrusted ICNS/JXL/HEIF image inputs through vulnerable image parsers.

## Workflow
1. Build slide content from a bounded structured spec.
2. Use a consistent theme/master, margins and type scale.
3. Prefer native PowerPoint text, tables, charts and shapes over screenshots.
4. Write generated decks under `output/pptx/` or the active project output folder.
5. Open or render the generated deck for visual QA.
6. Check clipping, overlaps, unreadable tables, wrong aspect ratios and stale template content.
7. Use the existing `slide-design` skill for design rules and visual refinement.

## Minimal pattern
```js
import pptxgen from "pptxgenjs";
const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
const slide = pptx.addSlide();
slide.addText("Title", { x: 0.7, y: 0.6, w: 12, h: 0.5, fontSize: 26, bold: true });
await pptx.writeFile({ fileName: "output/pptx/example.pptx" });
```

## Final gate
Do not mark a deck complete until the PPTX opens successfully and the edited/generated slides have been visually inspected.
