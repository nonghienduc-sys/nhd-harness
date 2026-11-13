# NHD ChatGPT UI Response Speed — Production Cutover Receipt (2026-11-08)

## Scope
Deploy only the ChatGPT Plus tok/s UI telemetry API to active NHD atomic runtime. Do not deploy unrelated video, browser tools, MCP registry or other changes present in the workspace dist.

## Release preparation and verification
- Base production release: \`v0.24.7-0fbe31e1ce8f\`.
- Narrow candidate: \`v0.24.7-2635b333359a\`.
- Only changed files relative to base: \`dist/server.js\` (adds response-speed routes) and \`dist/response-speed-benchmark.js\` (new data store).
- Byte-level precondition: rebuilt server diff against previous production contains only the benchmark import, constructor and four API endpoints; compiled sha256 \`165860DCDD939034BDEA3A669C29E958A404C34AB7A5F126B27F8F0E1F1B316B\`.
- New store compiled sha256 \`9AC50EF9D1483124EA970F20DB9DD0CFA090F041E29FAE7B8BD89F98A8944D23\`.
- Candidate deployment hash: \`2635b333359a02a0b8336d035ca45d0b187f9b5a4cf51e96f13664b3a6036fc0\`.
- Candidate isolated smoke (port 39290, sandbox data directory): **11/11 assertions true**. Tested valid JSON summary, localhost storage isolation, origin rejection, test sample save, estimated 50 tok/s for 800 visible chars over 4 seconds, deduplication, invalid input rejection, CSV export, stable release hash.
- Sandbox sample is **not a real ChatGPT measurement** and not part of production dataset.
- Sandbox smoke receipt: \`deploy-backups/response-speed-20261108/candidate-smoke-v0.24.7-2635b333359a.json\`.

## Atomic production cutover
- Candidate staged and verified through \`scripts/atomic-release.mjs verify\`, with immutable release hash and smoke receipt attached.
- Existing \`scripts/cutover-atomic-release.ps1\` controller launched in separate PowerShell process (auto-rollback enabled).
- Final cutover receipt: \`deploy-backups/response-speed-20261108/cutover-v0.24.7-2635b333359a.json\`.
- Receipt \`ok: true\`, at \`2026-11-07T21:45:56.8699529Z\`, recovery \`11619.2ms\`.
- All **11/11 post-cutover assertions true** including current/active identity, cleared candidate, old release as rollback, governor, unchanged tunnel supervisor PID \`14860\`, unchanged tunnel PID \`9988\`, unchanged tunnel connection timestamp, zero fast health failures.
- Live backend PID after cutover \`7888\`; fast health state \`healthy\`.
- Atomic pointer generation \`24\` current \`v0.24.7-2635b333359a\`; previous rollback \`v0.24.7-0fbe31e1ce8f\`.

## Live API readback
- At \`2026-11-08T04:46:30+07:00\`, direct production GET \`http://127.0.0.1:39100/api/benchmarks/response-speed/summary\` parsed as JSON, not HTML SPA.
- GET recent samples and export routes operational.
- Production CSV \`D:\NHD Projects\Model Benchmark MCP\ChatGPT Plus UI\chatgpt-plus-ui-speed.csv\` exists with header only.
- Production JSONL file does not exist yet because **zero genuine UI samples**.
- No production speed/tok/s figure claimed.

## Browser follow-up and limits
- Initially browser bridge disconnected, but later after opening Cốc Cốc extension management, authoritative NHD \`coc_coc_status\` reported \`connected:true, connectedTabs:1\` with an active YouTube tab; tab enumeration exposed installed manager tab \`coccoc://extensions/?id=pcfoffcjbjopclimcmgbappfifdieacn\`. Thus the extension is installed/connected in the actual browser session; earlier filesystem \`Preferences\` scan was incomplete and should not be used as proof of missing extension.
- A host-tab activation attempt via \`coc_coc_tab(action=activate)\` returned \`Background mode cannot activate/switch a host Cốc Cốc tab. Use isolated browser GUI work instead.\`; \`desktop_action\` rejected mutation because the tool does not expose a required task_run_id parameter. **No UI policy workaround was attempted.**
- Content scripts were edited on disk but a live browser extension reload was not independently verified. User must reload NHD extension from Cốc Cốc extension manager, then switch to ChatGPT page and send a new test prompt to generate real streaming data.
- Source extension located at \`D:\ChatGPT-Workstation-MCP\browser-extension\chat-health\`. Options supports toggling benchmark capture and labeling model/workload; CSV/JSONL export and localhost NHD sync.
- Cốc Cốc current media/video tabs were not closed, and no user chat message was submitted.
- Resume with \`coc_coc_status\`, live summary, Options sample count and readback of first real sample after extension reload.

## Rollback
Atomic previous release exists at \`D:\ChatGPT-Workstation-MCP\releases\v0.24.7-0fbe31e1ce8f\`. Standard rollback command \`node scripts/atomic-release.mjs rollback --root D:\ChatGPT-Workstation-MCP\` only when explicitly needed (then backend cutover/restart, health checks). Preserve the existing receipt and automatic rollback mechanism.
