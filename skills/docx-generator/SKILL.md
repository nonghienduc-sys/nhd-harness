---
name: docx-generator
description: Generate structured .docx files programmatically with the docx JavaScript library, especially for reports, forms, tables and repeatable document templates before high-fidelity Word finalization.
---

# DOCX Generator

## Purpose
Use when the user needs repeatable Word document generation from structured data, especially reports, tables, forms, checklists and template-driven documents.

## Runtime
- Node package: `docx`
- Upstream: dolanmiu/docx
- Installed target: 9.7.1

## Workflow
1. Generate a new file rather than modifying an existing high-fidelity document unless explicitly requested.
2. Encode structure with headings, paragraphs, tables, page settings and reusable styles.
3. Keep Vietnamese administrative-document rules in the existing Nghị định 30 / specialized-format skills; this generator is only the document-construction layer.
4. Write generated files under `output/docx/` or the active project output folder.
5. Open the output in Word for final field/layout verification when fidelity matters.
6. Run the existing Word structural/visual QA before delivery.

## Minimal pattern
```js
import { Document, Packer, Paragraph } from "docx";
import { writeFile } from "node:fs/promises";
const doc = new Document({ sections: [{ children: [new Paragraph("NHD MCP")] }] });
await writeFile("output/docx/example.docx", await Packer.toBuffer(doc));
```

## Final gate
Verify the .docx opens without repair prompts. For official/admin documents, apply the specialized Vietnamese formatting workflow after generation.
