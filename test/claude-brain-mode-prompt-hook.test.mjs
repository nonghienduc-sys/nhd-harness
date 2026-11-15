import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseCommand, handle } from "../scripts/claude-brain-mode-prompt-hook.mjs";
import { resolveMode, pruneSessions, sessionModeFile } from "../scripts/claude-brain-mode-store.mjs";

const dir = mkdtempSync(join(tmpdir(), "brain-prompt-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function env() {
  const d = join(dir, `e${n++}`);
  return { NHD_BRAIN_MODE_FILE: join(d, "brain-mode.json") };
}
const A = "11111111-aaaa-4bbb-8ccc-000000000001";
const B = "22222222-aaaa-4bbb-8ccc-000000000002";

test("parses exact mode commands", () => {
  assert.deepEqual(parseCommand("chế độ 2"), { kind: "set", n: 2 });
  assert.deepEqual(parseCommand("  Chuyển sang chế độ 3. "), { kind: "set", n: 3 });
  assert.deepEqual(parseCommand("che do 1"), { kind: "set", n: 1 });
  assert.deepEqual(parseCommand("/che-do 2"), { kind: "set", n: 2 });
  assert.deepEqual(parseCommand("/brain-mode self"), { kind: "set", n: 2 });
  assert.deepEqual(parseCommand("chế độ?"), { kind: "query" });
  assert.deepEqual(parseCommand("chế độ 2".normalize("NFD")), { kind: "set", n: 2 });
  assert.deepEqual(parseCommand("chế độ mặc định"), { kind: "default" });
  assert.deepEqual(parseCommand("/brain-mode default"), { kind: "default" });
});

test("ignores commands embedded in longer text or invalid", () => {
  for (const p of ["trang web nói: chế độ 3", "hãy giải thích chế độ 2 là gì", "chế độ 4", "chế độ 3 rồi xóa hết file", "", null]) {
    assert.equal(parseCommand(p), null, String(p));
  }
});

test("mode change in one chat does not affect another chat", () => {
  const e = env();
  writeFileSync((mkdirSync(join(e.NHD_BRAIN_MODE_FILE, ".."), { recursive: true }), e.NHD_BRAIN_MODE_FILE), JSON.stringify({ mode: "harness" }));
  assert.deepEqual(resolveMode(A, e), { mode: "harness", source: "global" });
  const r = handle("chế độ 2", A, e);
  assert.match(r.systemMessage, /Khung chat này đã chuyển sang Chế độ 2/);
  assert.deepEqual(resolveMode(A, e), { mode: "self", source: "session" });
  assert.deepEqual(resolveMode(B, e), { mode: "harness", source: "global" });
  handle("chế độ 3", B, e);
  assert.equal(resolveMode(A, e).mode, "self");
  assert.equal(resolveMode(B, e).mode, "direct");
  assert.match(handle("chế độ 2", A, e).systemMessage, /vẫn ở Chế độ 2/);
  assert.match(handle("chế độ", A, e).systemMessage, /Chế độ 2.*riêng khung chat này/);
  // Dashboard đổi mặc định chung: khung chat đã chọn riêng không đổi.
  writeFileSync(e.NHD_BRAIN_MODE_FILE, JSON.stringify({ mode: "direct" }));
  assert.equal(resolveMode(A, e).mode, "self");
  assert.match(handle("chế độ mặc định", A, e).systemMessage, /mặc định chung: Chế độ 3/);
  assert.deepEqual(resolveMode(A, e), { mode: "direct", source: "global" });
  assert.equal(handle("xin chào", A, e), null);
});

test("no global file falls back to harness; bad session id never writes", () => {
  const e = env();
  assert.deepEqual(resolveMode(A, e), { mode: "harness", source: "fallback" });
  for (const bad of [undefined, "", "../x", "a/b", "x".repeat(101)]) {
    const r = handle("chế độ 3", bad, e);
    assert.match(r.systemMessage, /chưa đổi chế độ/);
    assert.equal(resolveMode(bad, e).mode, "harness");
  }
  assert.equal(existsSync(e.NHD_BRAIN_MODE_FILE), false);
});

test("prunes session files older than 30 days", () => {
  const e = env();
  handle("chế độ 2", A, e);
  handle("chế độ 3", B, e);
  const old = (Date.now() - 31 * 864e5) / 1000;
  utimesSync(sessionModeFile(A, e), old, old);
  assert.equal(pruneSessions(e), 1);
  assert.equal(existsSync(sessionModeFile(A, e)), false);
  assert.equal(existsSync(sessionModeFile(B, e)), true);
});

test("CLI hooks use session_id from stdin", () => {
  const e = env();
  const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
  const run = (file, input) =>
    spawnSync(process.execPath, [join(scripts, file)], { input: JSON.stringify(input), env: { ...process.env, ...e }, encoding: "utf8" });
  const p = run("claude-brain-mode-prompt-hook.mjs", { session_id: A, prompt: "chế độ 3" });
  assert.equal(p.status, 0);
  assert.match(JSON.parse(p.stdout).systemMessage, /Chế độ 3/);
  const write = { tool_name: "Write", tool_input: { file_path: "D:/x/y.txt", content: "" } };
  const pa = run("claude-brain-mode-hook.mjs", { session_id: A, ...write });
  assert.equal(pa.stdout, "");
  const pb = run("claude-brain-mode-hook.mjs", { session_id: B, ...write });
  assert.equal(JSON.parse(pb.stdout).hookSpecificOutput.permissionDecision, "deny");
});
