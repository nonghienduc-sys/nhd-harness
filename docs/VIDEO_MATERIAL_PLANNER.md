# NHD AI Material Planner + OpenShot Editor Handoff v1

## Status and scope

NHD native MCP discovery/read-only tools: `media_source_status`, `media_source_discover`, `media_material_plan`, `media_material_rights_review`. The last two tools are newly implemented. The official OpenShot 4.1.1 editor CLI is installed on Windows and the bounded demo created a real, editable 6-clip .osp file. The **footage web suggestions are not imported**, because discovery results are not a license and human rights review remains pending.

## Design

- **Plan:** storyboard beats with deterministic start/duration -> explicit English shot queries and strategy `stock|mixed|graphics`; keep the original six narration timing boundaries at 30fps. Limit 1-8 scenes, 1-5 results per scene, <=300s timeline.
- **Search:** official APIs only. Commons handles image/video; Openverse handles images. YouTube and Google are reference-only; optional Pexels/Pixabay need runtime credentials. Per-request provider errors are redacted. Query memoization prevents repeated network calls.
- **Rank:** explainable keyword-overlap and aspect-ratio compatibility, resolution bonus, duplicate-use penalty, and downgrade for reference-only sources. The score is an aid, not visual semantic verification; `low` relevance blocks recommendation.
- **Rights:** every third-party asset is `reference_only` or `manual_review_required`, with a credit suggestion and checklist. CC BY-SA requires share-alike consideration; CC BY requires attribution; CC0/public domain still needs verification; stock licenses may have contextual/identity restrictions. No automatic license grant or external-content download.
- **Editor:** the OpenShot CLI `--cli session start/file import/clip add/project save` creates one editable `.osp`. The demo only imports the existing user project video (SHA-256 checked), splits it into six timeline segments, and preserves pending external stock as metadata.
- **QA:** compile/unit tests plus independent .osp JSON audit (source hash, only one original source, correct six clips, continuous 58.2-second 30fps 1920x1080 timeline, no unauthorized stock). This is *technical QA*, not subjective moving-frame assessment.

## Reproduce the working example

From `D:\ChatGPT-Workstation-MCP` on the user's Windows workstation (NHD Terminal preview/apply required):

```powershell
# The discovery step has already produced an immutable first-run manifest.
# Do not rerun on that existing path: the generator intentionally refuses overwrite.
node scripts/openshot-material-handoff.mjs --dry-run
node scripts/verify-openshot-material-handoff.mjs  # one-time receipt creation; refuses overwrite
```

To prepare a **different** video, first make a new storyboard/time-coded handoff folder and use the same tested code with a **new path** rather than overwriting the historical example. Explicit user authorization and NHD preview/apply are required for new project mutations and footage downloads.

### Demo artifacts

Root: `D:\NHD Projects\Nâng cấp Harness NHD\nhd-video-studio\nhd-video-studio\videos\api-goi-do-an-v4\materials`

- `material-plan.json` — real official-source search and explainable ranked candidates.
- `rights-review.md` — per-scene asset provenance, credit and license notes.
- `editor-handoff.json` — precise timing and original video hash, external import gate closed.
- `api-goi-do-an-v4-material-editor.osp` — actual editable OpenShot project, six clips.
- `editor-handoff-QA.json` — 13 deterministic technical checks.

### Current demo findings

Six scenes; 3 deliberately graphics-only, 3 eligible for stock research. Query returned five candidates, of which two scenes have a plausible candidate; the intro/hook needs a refined search. No footage is approved for automatic import. The prior original MP4 and voice remain unchanged.

### Operational limitations

1. A successful material plan does not establish copyright/derivative rights or guarantee the footage depicts the shot. Real preview and legal checks are mandatory before import.
2. YouTube Data API key was previously tested only in a temporary PowerShell process and was cleared. Do not reuse the value that was shared in ChatGPT. A rotated restricted key must be configured by the user securely for always-on runtime discovery.
3. The editor exposes a local CLI. Running it uses existing NHD Terminal Safety/Task Authorization preview/apply rather than giving a read-only discovery tool mutation privileges.
4. Do not automatically publish to YouTube, TikTok, or Facebook or strip stock attribution. No automated commercial license certification.
5. OpenShot normally exports H.264/AAC; the existing NHD Video Studio HEVC pipeline remains available for final Full HD 30fps deliverables where requested. Check device/platform compatibility and actual synced audio/video before release.

Sources: official OpenShot CLI documentation https://openshot.org/files/user-guide/agent_cli.html and official source-provider license pages.
