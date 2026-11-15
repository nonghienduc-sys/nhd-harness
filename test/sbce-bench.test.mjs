import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBenchTasks, runBenchTask, createBenchRun, summarizeBench, docFailures, unwrapDocument, roleForClass, listBenchRuns, readBenchSummary,
} from "../dist/sbce-bench.js";

const fixtures = fileURLToPath(new URL("./fixtures/sbce-bench/", import.meta.url));
const model = (id, roles, extra = {}) => ({ id, model: id, provider: "hhtech", protocol: "openai", family: id, tier: "T1", roles, enabled: true, vndPerM: 10000, ...extra });
const GOOD_EDIT = "FILE: src/add.mjs\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\nexport const add = (a, b) => a + b;\n>>>>>>> REPLACE\n";
const BAD_EDIT = "FILE: src/add.mjs\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\nexport const add = (a, b) => a * b;\n>>>>>>> REPLACE\n";

function fakeGenerator(replies) {
  const calls = [];
  return {
    calls,
    generate: async (input) => {
      calls.push(input);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return { text: next ?? "", usage: { input: 1000, output: 200, cached: 0 }, model: input.model.model, protocol: "openai" };
    },
  };
}

async function tmp() { return mkdtemp(join(tmpdir(), "bench-test-")); }

test("loadBenchTasks validates fixtures and roles map classes", async () => {
  const { tasks, errors } = await loadBenchTasks(fixtures);
  assert.deepEqual(errors, []);
  assert.deepEqual(tasks.map((t) => t.task.id), ["t-add", "t-doc", "t-judge"]);
  assert.equal(roleForClass("bugfix"), "coder");
  assert.equal(roleForClass("doc"), "writer");
  assert.equal(roleForClass("judge"), "judge");
  const missing = await loadBenchTasks(join(fixtures, "nope"));
  assert.deepEqual(missing.errors, ["SBCE_BENCH_TASKS_DIR_MISSING"]);
});

test("code task passes at attempt 1 with correct edit blocks", async () => {
  const dir = await tmp();
  try {
    const { tasks } = await loadBenchTasks(fixtures);
    const t = tasks.find((x) => x.task.id === "t-add");
    const gen = fakeGenerator([GOOD_EDIT]);
    const r = await runBenchTask({ ...t, model: model("m1", ["coder"]), generator: gen, tmpRoot: dir });
    assert.equal(r.error, undefined, r.feedback);
    assert.equal(r.passAt1, true);
    assert.equal(r.attempts, 1);
    assert.equal(r.costVnd, 12);
    assert.match(gen.calls[0].prompt, /    1\| export const add/);
    assert.doesNotMatch(gen.calls[0].prompt, /assert\.equal/, "hidden tests must not be sent");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("code task gets one fix round with feedback, then pass@2", async () => {
  const dir = await tmp();
  try {
    const { tasks } = await loadBenchTasks(fixtures);
    const t = tasks.find((x) => x.task.id === "t-add");
    const gen = fakeGenerator([BAD_EDIT, GOOD_EDIT]);
    const r = await runBenchTask({ ...t, model: model("m1", ["coder"]), generator: gen, tmpRoot: dir });
    assert.equal(r.passAt1, false);
    assert.equal(r.passAt2, true);
    assert.equal(r.attempts, 2);
    assert.match(gen.calls[1].prompt, /Hidden tests failed/);
    assert.match(gen.calls[1].prompt, /YOUR PREVIOUS REPLY/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("edits to tests are refused and generator errors are recorded", async () => {
  const dir = await tmp();
  try {
    const { tasks } = await loadBenchTasks(fixtures);
    const t = tasks.find((x) => x.task.id === "t-add");
    const sneaky = "FILE: test/add.test.mjs\n<<<<<<< SEARCH\n=======\nimport test from 'node:test';\ntest('x', () => {});\n>>>>>>> REPLACE\n";
    const r = await runBenchTask({ ...t, model: model("m1", ["coder"]), generator: fakeGenerator([sneaky, sneaky]), tmpRoot: dir });
    assert.equal(r.passAt2, false);
    assert.match(r.feedback, /test files are not allowed/);
    const e = await runBenchTask({ ...t, model: model("m1", ["coder"]), generator: fakeGenerator([new Error("HHTECH_TIMEOUT")]), tmpRoot: dir });
    assert.equal(e.error, "HHTECH_TIMEOUT");
    assert.equal(e.passAt2, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("doc checks, in_section and fence unwrapping", async () => {
  const checks = { output_path: "N.md", must_include: ["## Hello"], in_section: { "## Hello": ["world"] }, must_not_include: ["TODO"], max_chars: 200 };
  assert.deepEqual(docFailures("## Hello\nworld\n", checks), []);
  assert.equal(docFailures("## Hello\n\n## Other\nworld\n", checks).length, 1);
  assert.equal(docFailures("## Hello\nworld TODO\n", checks).length, 1);
  assert.equal(unwrapDocument("```markdown\n## Hello\nworld\n```"), "## Hello\nworld\n");
  const { tasks } = await loadBenchTasks(fixtures);
  const t = tasks.find((x) => x.task.id === "t-doc");
  const gen = fakeGenerator(["## Hello\nnothing\n", "```md\n## Hello\nworld\n```\n"]);
  const r = await runBenchTask({ ...t, model: model("w", ["writer"]), generator: gen, tmpRoot: tmpdir() });
  assert.equal(r.passAt1, false);
  assert.equal(r.passAt2, true);
  assert.match(gen.calls[1].prompt, /must be under ## Hello/);
});

test("judge scoring never leaks the reason and needs structured JSON", async () => {
  const { tasks } = await loadBenchTasks(fixtures);
  const t = tasks.find((x) => x.task.id === "t-judge");
  const gen = fakeGenerator(['{"pass": false, "reason": "multiplies"}']);
  const r = await runBenchTask({ ...t, model: model("j", ["judge"]), generator: gen, tmpRoot: tmpdir() });
  assert.equal(r.correct, true);
  assert.doesNotMatch(gen.calls[0].prompt, /secret-reason-never-sent/);
  assert.match(gen.calls[0].prompt, /a \* b/);
  const wrong = await runBenchTask({ ...t, model: model("j", ["judge"]), generator: fakeGenerator(['{"pass": true, "reason": "ok"}']), tmpRoot: tmpdir() });
  assert.equal(wrong.correct, false);
  const junk = await runBenchTask({ ...t, model: model("j", ["judge"]), generator: fakeGenerator(["looks fine to me"]), tmpRoot: tmpdir() });
  assert.equal(junk.correct, false);
  assert.equal(junk.error, "SBCE_JUDGE_UNSTRUCTURED");
});

test("bench run plans by role, respects budget, writes jsonl and summary", async () => {
  const out = await tmp();
  try {
    const { tasks } = await loadBenchTasks(fixtures);
    const models = [model("c1", ["coder", "writer"]), model("j1", ["judge"])];
    const replies = new Map([["c1", GOOD_EDIT], ["j1", '{"pass": false, "reason": "x"}']]);
    const generator = { generate: async (i) => {
      const text = i.system.includes("technical writer") ? "## Hello\nworld\n" : replies.get(i.model.id);
      return { text, usage: { input: 100, output: 50, cached: 0 }, model: i.model.id, protocol: "openai" };
    } };
    const run = createBenchRun({ tasks, models, generator, outDir: out, tmpRoot: out, runs: 2, concurrency: 2, now: () => new Date("2026-11-13T01:02:03.456Z") });
    assert.equal(run.planned, 6); // (t-add,c1)+(t-doc,c1)+(t-judge,j1) x 2 runs
    await run.promise;
    assert.equal(run.state.status, "done");
    assert.equal(run.state.completed, 6);
    const lines = (await readFile(join(out, `${run.state.runId}.jsonl`), "utf8")).trim().split("\n");
    assert.equal(lines.length, 6);
    const saved = await readBenchSummary(out, run.state.runId);
    assert.equal(saved.summary.ranking.bugfix[0].modelId, "c1");
    assert.equal(saved.summary.ranking.judge[0].rate2, 100);
    assert.deepEqual((await listBenchRuns(out)).map((x) => x.runId), [run.state.runId]);

    const capped = createBenchRun({ tasks, models, generator, outDir: out, tmpRoot: out, runs: 1, concurrency: 1, budgetVnd: 1, now: () => new Date("2026-11-13T02:00:00Z") });
    await capped.promise;
    assert.equal(capped.state.completed, 1);
    assert.equal(capped.state.skipped, 2);
    assert.equal(capped.state.stoppedReason, "SBCE_BENCH_BUDGET_REACHED");
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("summarizeBench ranks by pass@2, then pass@1, then cost", () => {
  const base = { class: "bugfix", difficulty: "easy", tier: "T1", run: 1, tokensIn: 0, tokensOut: 0, latencyMs: 10, attempts: 1 };
  const s = summarizeBench([
    { ...base, taskId: "a", modelId: "cheap", passAt1: false, passAt2: true, costVnd: 1 },
    { ...base, taskId: "a", modelId: "first", passAt1: true, passAt2: true, costVnd: 50 },
    { ...base, taskId: "a", modelId: "bad", passAt1: false, passAt2: false, costVnd: 0, error: "SBCE_X: y" },
  ], []);
  assert.deepEqual(s.ranking.bugfix.map((x) => x.modelId), ["first", "cheap", "bad"]);
  assert.equal(s.models.find((m) => m.modelId === "bad").errorKinds.SBCE_X, 1);
});
