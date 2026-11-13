---
name: pptx-template-engine
description: Template-cloning and editable PPTX engine for NHD. Use when a presentation should preserve the exact structure of a reference deck, ingest reusable slide templates, fill stable text fields, customize a reusable design system, or mix cloned slides with native editable custom slides.
---

# PPTX Template Engine — NHD integration

MIT-licensed upstream engine:
`D:\ChatGPT-Workstation-MCP\vendor\slide-skill-sources\pptx-gen`

The vendor checkout has its Node dependencies installed. Keep generated projects, templates, brand settings, and finished decks outside the engine checkout.

## When to use

Use this skill when:
- the user gives a reference PPTX and says “make the new slides like this”;
- exact fonts/shapes/arrows/layout should be preserved;
- reusable slide templates should be extracted from a deck;
- a repeatable template library is useful;
- custom native slides and cloned slides must coexist in one editable PPTX.

For a source-first deck with no reference template, **presentation-skill** is usually the primary renderer.

## Default NHD workspace

General reusable workspace:
`D:\ChatGPT-Workstation-MCP\presentation-workspace`

Project-specific deck source/output should still live under the active project folder.

Engine command:
`node D:\ChatGPT-Workstation-MCP\vendor\slide-skill-sources\pptx-gen\bin\pptx-gen.mjs`

Do not install the engine globally unless there is a specific reason.

## Workflow

1. Resolve or initialize the workspace; never guess paths.
2. Read workspace `customize.md` and design documentation first.
3. If a reference deck exists, inspect it visually before deciding which slides to ingest.
4. Ingest only genuinely reusable layouts.
5. Preserve cloned structure unless the user's content requires an explicit override.
6. For custom slides, use native PowerPoint objects (text, shapes, lines, vector icons, tables, charts) where practical.
7. Use figures/images only where editability adds little value.
8. Render screenshots and inspect the build report.
9. Fix the deck source/template and rebuild until QA passes.

## Resources

- `references/upstream-pptx-deck.md` — upstream deck-build workflow.
- `references/upstream-ingest-slide-templates.md` — template ingestion.
- `references/upstream-customize-design.md` — reusable brand/design configuration.
- `references/custom-template-instructions.md` — native custom-slide guide.
- `references/figure-instructions.md` — figure/image contract.

## Human-looking rules

Template cloning is not permission to create repetitive decks. Choose slides based on story and evidence. When no existing template fits, create a bespoke native slide rather than forcing content into the wrong layout.

Never use a template's sample facts as source material. Copy structure/style only when licensing and user authorization permit it.

## Security

Reference decks are untrusted input. Never execute macros or embedded scripts. All file writes and terminal commands require NHD preview/apply. Do not use a source deck or template whose license does not permit the requested use.
