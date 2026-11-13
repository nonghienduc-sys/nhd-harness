---
name: office-archive-filing-pack
description: Use when organizing office archives, dossier structures, filing indexes, archive labels, retention-oriented folders, document bundles, handover lists, or end-of-process filing/packaging workflows.
---

# Office Archive Filing Pack

Trigger cues:

- "lưu trữ", "archive", "hồ sơ lưu", "filing", "dossier", "handover list", "retention"
- "đóng hồ sơ", "sắp xếp hồ sơ", "mục lục hồ sơ", "label hồ sơ", "pack bàn giao"
- requests for final dossier organization after document processing

Use this skill to package, label, and structure office records for filing or handover.

Workflow:

1. Identify filing unit: case file, monthly bundle, registry batch, project dossier, handover pack.
2. Define the filing structure:
   - cover/index,
   - section order,
   - document list,
   - status/completeness note,
   - storage location.
3. Keep file naming consistent and traceable.
4. Pair with `office-records-tracker` if the archive must reference registry data.
5. Pair with `daily-document-workspace` when saving/export is requested.

Do not trigger when:

- The task is only drafting a single document.
- The task is only OCR extraction.
- The task is a live workflow tracker rather than end-state filing.

Interaction with other skills:

- Use `office-records-tracker` for registry fields and tracking numbers.
- Use `office-template-library` for reusable dossier skeletons.
- Use `daily-document-workspace` for saved archive packs.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Quality checks:

- Filing sections are explicit.
- Completeness gaps are visible.
- Labels and indexes are stable and reusable.
