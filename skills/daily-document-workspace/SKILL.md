---
name: daily-document-workspace
description: Use when creating, saving, organizing, or exporting user-facing documents, reports, bundles, test outputs, Markdown, Word, PDF, TXT, JSON, manifests, or source copies for this user. Always save outputs under D:/Không gian Ai in a daily folder named dd-MM-yyyy, create the folder if missing, avoid overwriting existing files, and include a short manifest when multiple files are produced.
---

# Daily Document Workspace

Trigger cues:

- "lưu", "tạo file", "xuất", "export", "tổng hợp thành folder", "lưu tài liệu"
- "Markdown", "Word", "PDF", "TXT", "manifest", "bundle"
- Any request to create user-facing output files for later use

When saving files for the user:

1. Use `D:/Không gian Ai` as the root folder.
2. Create or reuse today's folder with `Get-Date -Format "dd-MM-yyyy"`, for example `14-05-2026`.
3. Save all final user-facing outputs under that daily folder.
4. For multi-file outputs, create a descriptive subfolder and include:
   - `README.md` explaining contents.
   - `manifest.json` mapping source inputs to output files when relevant.
   - `source/` or `source-jobs/` copies when the user provided source files.
5. Never overwrite an existing file unless the user explicitly asked for replacement. If a name exists, append a timestamp or short suffix.
6. In the final answer, return full absolute Windows paths.

Preferred structure:

```text
D:/Không gian Ai/
  dd-MM-yyyy/
    project-or-task-name/
      README.md
      manifest.json
      outputs/
      source/
```

If the task is a single document, save it directly in the date folder unless a subfolder would make the result clearer.

Do not trigger when:

- The user only asks for advice, explanation, or a draft in chat and does not ask to save/export/create a file.
- The user explicitly says not to create a file.

Conflict handling:

- If another skill creates a document, this skill still controls final storage.
- If the user gives a different destination, follow the user's explicit path for that task only.
- If today's folder does not exist, create it before writing outputs.
- If shell execution is blocked, prepare files in the writable workspace and explain what still needs to be moved.
- When paired with `vietnam-admin-documents`, `message-intake-tasks`, or `model-audit-bundle`, do not change their content format; only choose final storage paths.

Final answer checklist:

- Mention the exact saved path.
- Mention whether a new folder was created or reused.
- Mention if any file was renamed to avoid overwrite.
- Follow the contract in `OUTPUT_CONTRACTS.md`.

Overwrite policy:

- If an existing destination file is found, do not overwrite.
- Use suffix `-HHmmss` or a short unique suffix.
- Only overwrite when the user clearly says to replace the existing file.
