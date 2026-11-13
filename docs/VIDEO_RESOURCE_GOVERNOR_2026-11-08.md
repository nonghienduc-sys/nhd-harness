# NHD / Cốc Cốc video performance hardening — 2026-11-08

## Scope and observed evidence
- User confirmed Cốc Cốc became substantially smoother after one verified extension renderer process PID 22240 was stopped at 02:38:03 local.
- That process was `browser.exe --extension-process`, ~569.5 MB at shutdown. Its owning extension **was not identified** and may not be attributed to NHD or any video extension.
- A later 02:56:21 sample confirmed PID 22240 remained absent; all remaining extension processes together were ~604 MB and 1.6% of one CPU core, browser main process 3.1% of one core. This is an observation under changing page workloads, not a controlled A/B benchmark.
- Installed in the Default Cốc Cốc profile: `Download video & audio` (ID `jdfkmiabjpfjacifcmihfdjhpnjpiick`, v2.4.69), `Language Learning with Netflix & YouTube-AFL`, `Dictionary and Translation`, and `NHD MCP Cốc Cốc Agent Sensor` (ID `pcfoffcjbjopclimcmgbappfifdieacn`, v0.4.2).
- **No assertion that PID 22240 belongs to any listed extension.**
- NHD video-intelligence cache: 32 job folders, 421 files, 17.7 MB, 0 orphan .part/.tmp/.ytdl files; no live ffmpeg/ffprobe/yt-dlp/transcriber children at inspection time.

## Source changes
- New `src/video-process-gate.ts`: global concurrency cap for NHD video subprocesses (default 2, environment override `NHD_VIDEO_MAX_CHILDREN` clamped to 1–4); bounded FIFO queue of 16, maximum queue wait 5 min; guaranteed slot release on fulfilled/rejected operations.
- `src/video.ts`: wraps `runProcess` with the gate; exposes `processGovernor` counters through video status; removes only **new job-owned downloaded audio working copy** after ASR attempt in finally; keeps user source video, reusable transcripts, manifests and keyframes.
- `skills/video-understanding/SKILL.md`: prevents indefinite video monitoring through Cốc Cốc download extensions, requires caption-first/sparse frame acquisition, reiterates no deletion of user media or unknown process kills.
- Did not change third-party extension binaries, user downloads, browser tabs, Office, Safety, runtime leases, or trading engine.

## Build, promotion and verification
- TypeScript `tsc --noEmit`: PASS.
- New gate tests: 4/4 PASS.
- Targeted NHD tests for video, video governor, Coc Coc bridge, browser orchestration: 21/21 PASS.
- Isolated stage: `.video-governor-build-20261108`.
- Promoted only `dist/video.js` SHA-256 `5B0F0C5149479254646826BD9931BD41B66E9DC16BB3C9D36F54BA1CE6396079` and `dist/video-process-gate.js` SHA-256 `B760EFE76BE92397382E8D897D62A596C9414623ED6B5F19295D7696DA8CCE5B`.
- Deployment backup and JSON receipt: `deploy-backups/video-governor-20261108/receipt.json`. Original `dist/video.js` retained as backup, SHA-256 `C1FB37A78936ED381F1945D0896B13E422C30F3EA28F05474CAF10C8CD70928F`.
- Original `src/video.ts` retained as `src/video.ts.pre-resource-gate-20261108.bak`, SHA-256 `727AF0BF2FF01FE40473D011D00DDCEA54E3416A32919454404EB597F25EF6A1`.

## Deployment limits / next checks
- **Status: SOURCE+DIST PROMOTED; LIVE NHD BACKEND NOT RESTARTED.** Existing long-running process still reports video dependencies without `processGovernor`; the governor will become active after a safe NHD backend restart. No automatic backend restart was performed because it could interrupt unrelated in-flight tasks.
- Cốc Cốc DOM bridge returned to `connected=true` for one tab during final validation. This is not proof of the video governor being live.
- **Third-party video extension has not been permanently disabled** because the provided Cốc Cốc connection cannot navigate `coccoc://extensions` and the host desktop mutation interface did not accept a task-scoped action. To keep Cốc Cốc light, disable `Download video & audio` using the extension manager (ID above), but this is a precaution and not proof it owned PID 22240.
- Next controlled acceptance: stop any unrelated NHD work; restart NHD Control Center/backend; call `video_inspect` without a source and verify `dependencies.processGovernor.limit === 2`. Then run a bounded synthetic concurrency test and repeat a comparable CPU/RAM sample in Cốc Cốc. Do not reactivate the suspect PID solely to benchmark it.
