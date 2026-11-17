import test from "node:test";
import assert from "node:assert/strict";
import { selectNewHiddenWordProcesses, cleanWordProcesses, wordCleanupEnabled } from "../dist/word-cleanup.js";

const proc = (pid, parentPid, startedAt, mainWindowTitle = "") => ({ pid, parentPid, startedAt, mainWindowTitle });

test("WINWORD cleanup filters old PIDs, visible Word and unrelated/older hidden PIDs", () => {
  const old = [proc(10, 1, 100, ""), proc(20, 1, 100, "User document")];
  const after = [
    ...old, proc(30, 999, 205, ""), proc(40, 999, 205, "Visible document"),
    proc(50, 999, 50, ""), proc(60, 777, 205, "")
  ];
  const chosen = selectNewHiddenWordProcesses(old, after, 200, 230, 999);
  assert.deepEqual(chosen.map((p) => p.pid), [30, 60]);
});

test("WINWORD cleanup kills only new, still-hidden, identical instances", async () => {
  const prior = [proc(10, 1, 100), proc(20, 1, 100, "User document")];
  const after = [...prior, proc(30, 999, 205), proc(40, 999, 205, "Document"), proc(50, 888, 205)];
  const killed = [];
  let calls = 0;
  const provider = {
    async list() {
      calls++;
      if (calls === 1) return after;
      return [...prior, proc(30, 999, 205), proc(40, 999, 205, "Document"), proc(50, 888, 205, "Now visible")];
    },
    async kill(pid) { killed.push(pid); },
    async sleep(ms) { assert.equal(ms, 10000); }
  };
  const out = await cleanWordProcesses({ before: prior, commandPid: 999, startedAt: 200, endedAt: 250 }, provider);
  assert.deepEqual(killed, [30]);
  assert.deepEqual(out.killed, [30]);
  assert.ok(out.kept.includes(10));
  assert.ok(out.kept.includes(20));
  assert.ok(out.kept.includes(40));
  assert.ok(out.kept.includes(50));
});

test("WINWORD disabled on non-Windows or through environment", () => {
  assert.equal(wordCleanupEnabled({}, "linux"), false);
  assert.equal(wordCleanupEnabled({ NHD_WORD_CLEANUP: "0" }, "win32"), false);
  assert.equal(wordCleanupEnabled({}, "win32"), true);
});
