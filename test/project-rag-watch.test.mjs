// 0.24.33: owner-enabled RAG auto-sync (watch project folder, re-ingest changes, remove deleted files).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProjectRagService } from "../dist/project-rag.js";
import { ProjectRagWatcher } from "../dist/project-rag-watch.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mkStore = () => { const events = []; return { events, audit: (action, status, detail) => events.push({ action, status, detail }) }; };
const realRag = dir => new ProjectRagService({ projectWorkspaceRoot: dir }, { resolvePath: p => resolve(p) }, { read: async () => { throw Error("no pdf"); } });

test("auto-sync: enable indexes eligible files, skips excluded/secret/temp files, persists state", { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nhd-rag-watch-"));
  const root = join(dir, "PROJ");
  mkdirSync(join(root, "docs"), { recursive: true }); mkdirSync(join(root, "SKIP"));
  writeFileSync(join(root, "docs", "a.md"), "# Chăn nuôi\n\nHỗ trợ hộ nghèo nuôi trâu sinh sản 25 triệu đồng.", "utf8");
  writeFileSync(join(root, "SKIP", "b.md"), "# Bỏ qua\n\nKhông được nạp.", "utf8");
  writeFileSync(join(root, ".env"), "TOKEN=x", "utf8");
  writeFileSync(join(root, "docs", "~$a.docx"), "lock", "utf8");
  writeFileSync(join(root, "image.png"), "x", "utf8");
  const store = mkStore(), gate = { emergencyStop: false, writeEnabled: true };
  const statePath = join(dir, "state", "project-rag-watch.json");
  const rag = realRag(dir);
  const w = new ProjectRagWatcher(rag, { statePath, store, gate: () => gate, debounceMs: 300, rescanMs: 0 });
  try {
    const st = w.enable(root, ["SKIP"], "task-x");
    assert.equal(st.projects[0].root, root);
    assert.equal(st.projects[0].watching, "recursive");
    await w.idle();
    const manifest = await rag.indexedSources(root);
    assert.deepEqual(manifest.map(m => m.source), [join(root, "docs", "a.md")], "only the eligible, non-excluded file is indexed");
    assert.equal(w.status(root).projects[0].counters.ingested, 1);
    assert.ok(store.events.some(e => e.action === "project_rag_auto_ingest" && e.status === "success"));
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(saved.projects.map(p => [p.root, p.exclude]), [[root, ["SKIP"]]]);

    // A new file and an edit are picked up from fs events.
    writeFileSync(join(root, "docs", "c.txt"), "Nghị quyết 76 về đầu tư công trung hạn của xã.", "utf8");
    await sleep(500); await w.idle();
    writeFileSync(join(root, "docs", "a.md"), "# Chăn nuôi\n\nMức hỗ trợ mới: 30 triệu đồng mỗi hộ.", "utf8");
    await sleep(500); await w.idle();
    const q = await rag.query(root, "mức hỗ trợ mới mỗi hộ", 3, 1500);
    assert.ok(q.results.some(h => h.text.includes("30 triệu")), "edited file re-ingested, fresh evidence returned");
    assert.ok((await rag.query(root, "đầu tư công trung hạn", 3, 1500)).results.some(h => h.source.endsWith("c.txt")));

    // Deleting a file removes its chunks.
    unlinkSync(join(root, "docs", "c.txt"));
    await sleep(500); await w.idle();
    assert.deepEqual((await rag.indexedSources(root)).map(m => m.source), [join(root, "docs", "a.md")]);
    assert.ok(store.events.some(e => e.action === "project_rag_auto_remove"));
    const status = await rag.status(root);
    assert.equal(status.chunks, status.fts_chunks, "FTS stays consistent after removal");

    // Restore after restart: offline edits are reconciled.
    w.stopAll();
    writeFileSync(join(root, "docs", "d.md"), "# Ngoại tuyến\n\nTệp thêm khi harness tắt.", "utf8");
    const w2 = new ProjectRagWatcher(rag, { statePath, store, gate: () => gate, debounceMs: 300, rescanMs: 0 });
    w2.restore(); await w2.idle();
    assert.ok((await rag.indexedSources(root)).some(m => m.source.endsWith("d.md")));
    const off = w2.disable(root);
    assert.equal(off.wasWatched, true);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).projects, []);
    w2.stopAll();
  } finally { w.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("auto-sync: emergency stop pauses, failed files are not retried until changed, roots are validated", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nhd-rag-watch-unit-"));
  const root = join(dir, "P"); mkdirSync(root);
  writeFileSync(join(root, "ok.md"), "ok", "utf8"); writeFileSync(join(root, "bad.md"), "bad", "utf8");
  const real = realRag(dir);
  const calls = [];
  const rag = {
    resolveProject: r => real.resolveProject(r), scan: (r, e) => real.scan(r, e), eligible: (r, p) => real.eligible(r, p), excluded: (r, f, s) => real.excluded(r, f, s),
    indexedSources: async () => [], remove: async () => ({ removed_chunks: 0 }),
    index: async (_r, p) => { calls.push(p); if (p.endsWith("bad.md")) throw new Error("boom"); return { ok: true, unchanged: false, chunks: 1 }; },
  };
  const gate = { emergencyStop: true, writeEnabled: true };
  const fakeWatch = () => ({ on() {}, close() {} });
  const w = new ProjectRagWatcher(rag, { statePath: join(dir, "s.json"), store: mkStore(), gate: () => gate, debounceMs: 50, rescanMs: 0, watchFn: fakeWatch });
  try {
    assert.throws(() => w.enable(dir), /concrete project/, "workspace root refused");
    assert.throws(() => w.enable(root, ["..\\other"]), /relative folders/);
    w.enable(root);
    await sleep(100);
    assert.equal(calls.length, 0, "nothing ingested while Emergency Stop is on");
    assert.equal(w.status().paused, true);
    gate.emergencyStop = false;
    w.sync(root); await w.idle();
    assert.deepEqual(calls.map(p => p.split(/[\\/]/).pop()).sort(), ["bad.md", "ok.md"]);
    const st = w.status(root).projects[0];
    assert.equal(st.counters.failed, 1); assert.match(st.recentErrors[0].error, /boom/);
    calls.length = 0; w.sync(root); await w.idle();
    assert.deepEqual(calls.map(p => p.split(/[\\/]/).pop()), ["ok.md"], "unchanged failed file is not retried (fake manifest is empty so ok.md re-queues)");
    await sleep(20); writeFileSync(join(root, "bad.md"), "bad but changed", "utf8");
    calls.length = 0; w.sync(root); await w.idle();
    assert.ok(calls.some(p => p.endsWith("bad.md")), "changed file is retried");
  } finally { w.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("project_rag_ingest exposes watch ops and status reports autoSync", () => {
  const src = readFileSync("src/mcp-registries/project-rag-tools.ts", "utf8");
  for (const op of ["watch_enable", "watch_disable", "watch_sync"]) assert.ok(src.includes(op));
  assert.ok(src.includes("autoSync"));
  assert.ok(readFileSync("src/server.ts", "utf8").includes("projectRagWatch.restore()"));
  assert.ok(existsSync("dist/project-rag-watch.js"));
});
