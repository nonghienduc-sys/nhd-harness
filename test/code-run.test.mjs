import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { runCodeScript, codeRunToolAllowed, toolOutputValue, markCodeRunInnerExtra, isCodeRunInnerExtra } from "../dist/code-run.js";

const ok = (value) => ({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] });
const fakeDeps = (impl = {}) => {
  const seen = [];
  return {
    seen,
    checkTool: async (name) => codeRunToolAllowed(name, name.startsWith("ro_") ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false } : name === "rw_write" ? { readOnlyHint: false, destructiveHint: true } : undefined),
    callTool: async (name, args) => { seen.push({ name, args }); return impl[name] ? impl[name](args) : ok({ name, args }); },
  };
};

test("code_run: gọi nhiều tool, chỉ trả giá trị cuối", async () => {
  const deps = fakeDeps({ ro_list: () => ok({ files: ["a.txt", "b.txt", "c.md"] }), ro_read: (a) => ok({ text: "nội dung " + a.path }) });
  const r = await runCodeScript({ code: `
    const l = await tools.ro_list({ root: "X" });
    const reads = await Promise.all(l.files.filter(f => f.endsWith(".txt")).map(f => tools.ro_read({ path: f })));
    console.log("đã đọc", reads.length);
    return reads.map(x => x.text);` }, deps);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, ["nội dung a.txt", "nội dung b.txt"]);
  assert.equal(r.callCount, 3);
  assert.deepEqual(r.logs, ["đã đọc 2"]);
  assert.equal(deps.seen.length, 3);
});

test("code_run: tool không chỉ đọc / không tồn tại / chính nó bị từ chối, lỗi bắt được trong mã", async () => {
  const deps = fakeDeps();
  const r = await runCodeScript({ code: `
    const out = [];
    for (const n of ["rw_write", "khong_co", "code_run"]) { try { await callTool(n, {}); out.push("chay"); } catch (e) { out.push("tu_choi"); } }
    return out;` }, deps);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value, ["tu_choi", "tu_choi", "tu_choi"]);
  assert.equal(deps.seen.length, 0, "tool bị từ chối không được gọi thật");
});

test("code_run: lỗi tool (isError) ném ra trong mã", async () => {
  const deps = fakeDeps({ ro_x: () => ({ isError: true, content: [{ type: "text", text: "hỏng" }] }) });
  const r = await runCodeScript({ code: `await tools.ro_x({}); return 1;` }, deps);
  assert.equal(r.ok, false);
  assert.match(r.error, /hỏng/);
});

test("code_run: không có require/process/fetch; thoát vm vẫn bị khóa quyền tệp và tiến trình", async () => {
  const r = await runCodeScript({ code: `
    const out = { require: typeof require, process: typeof process, fetch: typeof fetch };
    let p = null;
    try { p = this?.constructor?.constructor?.("return process")?.(); } catch {}
    try { p = p ?? tools.constructor.constructor("return process")(); } catch {}
    out.escaped = p == null ? "none" : typeof p;
    if (p && p.mainModule === undefined && typeof p.getBuiltinModule === "function") {
      try { p.getBuiltinModule("node:fs").readFileSync("C:/Windows/win.ini"); out.fs = "DOC_DUOC"; } catch (e) { out.fs = e.code; }
      try { p.getBuiltinModule("node:child_process").execSync("echo x"); out.cp = "CHAY_DUOC"; } catch (e) { out.cp = e.code; }
      out.envKeys = Object.keys(p.env).filter(k => /KEY|TOKEN|SECRET|PASS/i.test(k));
    }
    return out;` }, fakeDeps());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.require, "undefined");
  assert.equal(r.value.process, "undefined");
  assert.equal(r.value.fetch, "undefined");
  // Không thoát được vm qua đối tượng host (context không nhận đối tượng host nào).
  assert.notEqual(r.value.escaped, "object", "không được lấy process qua constructor");
  if (r.value.fs) assert.notEqual(r.value.fs, "DOC_DUOC");
  if (r.value.cp) assert.notEqual(r.value.cp, "CHAY_DUOC");
});

test("code_run: tiến trình con bị khóa quyền tệp/tiến trình kể cả khi có process", async () => {
  const { CODE_RUN_CHILD_SOURCE } = await import("../dist/code-run.js");
  assert.ok(CODE_RUN_CHILD_SOURCE.length > 100);
  const out = await new Promise((done) => {
    const c = spawn(process.execPath, ["--permission", "-e", `
      const r = {}; try { require("node:fs").readFileSync("C:/Windows/win.ini"); r.fs = "DOC_DUOC"; } catch (e) { r.fs = e.code; }
      try { require("node:child_process").execSync("echo x"); r.cp = "CHAY_DUOC"; } catch (e) { r.cp = e.code; }
      process.stdout.write(JSON.stringify(r));`], { env: {}, windowsHide: true });
    let s = ""; c.stdout.on("data", (b) => { s += b; }); c.on("exit", () => done(JSON.parse(s)));
  });
  assert.equal(out.fs, "ERR_ACCESS_DENIED");
  assert.equal(out.cp, "ERR_ACCESS_DENIED");
});

test("code_run: trần thời gian dừng vòng lặp vô hạn (cả đồng bộ lẫn bất đồng bộ)", async () => {
  const t0 = Date.now();
  const a = await runCodeScript({ code: `while (true) {}`, timeoutMs: 1500 }, fakeDeps());
  assert.equal(a.ok, false);
  const b = await runCodeScript({ code: `await tools.ro_a({}); while (true) {}`, timeoutMs: 1500 }, fakeDeps());
  assert.equal(b.ok, false);
  assert.match(b.error, /Quá thời gian|timed out/i);
  assert.ok(Date.now() - t0 < 15000);
});

test("code_run: trần số lệnh, trần độ dài kết quả", async () => {
  const r = await runCodeScript({ code: `let n = 0; for (let i = 0; i < 5; i++) { try { await tools.ro_a({ i }); n++; } catch {} } return n;`, maxCalls: 3 }, fakeDeps());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value, 3);
  const big = await runCodeScript({ code: `return "x".repeat(5000);`, maxResultChars: 300 }, fakeDeps());
  assert.equal(big.truncated, true);
  assert.ok(String(big.value).length <= 300);
});

test("code_run: chính sách annotations", () => {
  assert.equal(codeRunToolAllowed("fs_read", { readOnlyHint: true, destructiveHint: false, openWorldHint: false }), null);
  assert.ok(codeRunToolAllowed("browser_read", { readOnlyHint: true, openWorldHint: true }));
  assert.ok(codeRunToolAllowed("fs_apply_write", { readOnlyHint: false, destructiveHint: true }));
  assert.ok(codeRunToolAllowed("x", undefined));
  assert.ok(codeRunToolAllowed("code_run", { readOnlyHint: true }));
  assert.ok(codeRunToolAllowed("fs_preview_write", { readOnlyHint: true, destructiveHint: false, openWorldHint: false }));
  assert.deepEqual(toolOutputValue({ content: [{ type: "text", text: "{\"a\":1}" }] }), { ok: true, value: { a: 1 } });
});

// ---- Tích hợp: server thật trong thư mục dữ liệu tạm, cổng riêng (không đụng backend đang chạy).
const root = resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rid = 0;
async function freePort() {
  return await new Promise((done, bad) => { const s = createServer(); s.once("error", bad); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); }); });
}
async function startServer(envOverrides = {}) {
  const data = mkdtempSync(join(tmpdir(), "nhd-code-run-"));
  const work = mkdtempSync(join(tmpdir(), "nhd-code-run-work-"));
  writeFileSync(join(work, "a.txt"), "dong mot\nTODO hai\n");
  writeFileSync(join(work, "b.txt"), "khong co gi\n");
  const localPort = await freePort(), corePort = await freePort();
  writeFileSync(join(data, "config.json"), JSON.stringify({
    roots: [work], writeEnabled: true, terminalEnabled: true, screenEnabled: false, desktopEnabled: false, browserEnabled: false,
    visualDesktopEnabled: false, intakeEnabled: false, localHarnessEnabled: true, localHarnessPort: localPort,
  }));
  const child = spawn(process.execPath, [join(root, "dist/server.js")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WORKSTATION_MCP_DATA_DIR: data, WORKSTATION_MCP_PORT: String(corePort), WORKSTATION_MCP_LOCAL_PORT: String(localPort),
      WORKSTATION_MCP_LOCAL_ENABLED: "1", NHD_RESULT_PAYLOAD_GATEWAY: "0", NHD_BRAIN_ONLY: "0", ...envOverrides },
  });
  let log = ""; child.stdout.on("data", (b) => { log = (log + b).slice(-3000); }); child.stderr.on("data", (b) => { log = (log + b).slice(-3000); });
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error("server exit: " + log);
    try { const r = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(500) }); if (r.ok) return { data, work, child, port: localPort }; } catch {}
    await sleep(150);
  }
  throw Error("server not ready: " + log);
}
async function rpc(s, method, params = {}) {
  const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "mcp-session-id": "code-run-test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
  const body = await res.json();
  if (!res.ok || body.error) throw Error(method + ": " + JSON.stringify(body.error ?? body).slice(0, 500));
  return body.result;
}

test("code_run tích hợp: gọi tool chỉ đọc thật qua governor, từ chối ghi/terminal", { timeout: 90000 }, async () => {
  const s = await startServer();
  try {
    await rpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "code-run-test", version: "1.0" } });
    const listed = await rpc(s, "tools/list");
    const tool = listed.tools.find((t) => t.name === "code_run");
    assert.ok(tool, "code_run có trong tools/list");
    assert.equal(tool.annotations?.readOnlyHint, true);
    const work = JSON.stringify(s.work);
    const target = JSON.stringify(join(s.work, "pwned.txt"));
    const out = await rpc(s, "tools/call", { name: "code_run", arguments: { code: `
      const names = (await callTool("tool_describe", { names: ["fs_read"] })) ? "ok" : "no";
      const a = await tools.fs_read({ path: ${JSON.stringify(join(s.work, "a.txt"))} });
      const text = JSON.stringify(a);
      const refused = [];
      for (const [n, args] of [["terminal_execute", { command: "echo pwned > " + ${target} }], ["fs_apply_write", { action_id: "x", confirmation_token: "y" }], ["fs_preview_write", { path: ${target}, content: "x" }]]) {
        try { await callTool(n, args); refused.push(n + ":CHAY"); } catch (e) { refused.push(n + ":TU_CHOI"); }
      }
      return { names, hasTodo: text.includes("TODO"), refused };` } });
    const sc = out.structuredContent;
    assert.equal(sc.ok, true, JSON.stringify(sc).slice(0, 800));
    assert.equal(sc.value.hasTodo, true);
    assert.deepEqual(sc.value.refused, ["terminal_execute:TU_CHOI", "fs_apply_write:TU_CHOI", "fs_preview_write:TU_CHOI"]);
    assert.equal(existsSync(join(s.work, "pwned.txt")), false);
    assert.ok(sc.calls.some((c) => c.name === "fs_read" && c.ok));
  } finally {
    s.child.kill();
    await Promise.race([new Promise((r) => s.child.once("exit", r)), sleep(3000)]);
    rmSync(s.data, { recursive: true, force: true }); rmSync(s.work, { recursive: true, force: true });
  }
});

test("code_run: dấu lượt gọi bên trong sống qua spread, không lẫn với extra thường", () => {
  const marked = markCodeRunInnerExtra({ sessionId: "s" });
  assert.equal(isCodeRunInnerExtra(marked), true);
  assert.equal(isCodeRunInnerExtra({ ...marked }), true);
  assert.equal(marked.sessionId, "s");
  assert.equal(isCodeRunInnerExtra(markCodeRunInnerExtra(undefined)), true);
  assert.equal(isCodeRunInnerExtra({ sessionId: "s" }), false);
  assert.equal(isCodeRunInnerExtra(undefined), false);
  assert.equal(isCodeRunInnerExtra(JSON.parse(JSON.stringify(marked))), false);
});

test("code_run tích hợp: lượt gọi bên trong nhận structuredContent gốc, không bị payload gateway nén", { timeout: 90000 }, async () => {
  const s = await startServer({ NHD_RESULT_PAYLOAD_GATEWAY: "1" });
  try {
    const many = join(s.work, "many"); mkdirSync(many);
    for (let i = 0; i < 300; i++) writeFileSync(join(many, "tep-so-" + String(i).padStart(4, "0") + "-ten-dai-cho-du-nguong.txt"), "x");
    await rpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "code-run-test", version: "1.0" } });
    const direct = await rpc(s, "tools/call", { name: "fs_list", arguments: { path: many, limit: 2000 } });
    assert.ok(JSON.stringify(direct).includes("_nhdPayloadGateway"), "gọi trực tiếp phải bị gateway nén (để test có nghĩa)");
    const out = await rpc(s, "tools/call", { name: "code_run", arguments: { code: `
      const l = await tools.fs_list({ path: ${JSON.stringify(many)}, limit: 2000 });
      return { keys: Object.keys(l).sort(), count: l.entries.length, entry: Object.keys(l.entries[0]).sort() };` } });
    const sc = out.structuredContent;
    assert.equal(sc.ok, true, JSON.stringify(sc).slice(0, 800));
    assert.deepEqual(sc.value.keys, ["entries"]);
    assert.equal(sc.value.count, 300);
    assert.deepEqual(sc.value.entry, ["modifiedAt", "name", "path", "size", "type"]);
  } finally {
    s.child.kill();
    await Promise.race([new Promise((r) => s.child.once("exit", r)), sleep(3000)]);
    rmSync(s.data, { recursive: true, force: true }); rmSync(s.work, { recursive: true, force: true });
  }
});
