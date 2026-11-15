import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBenchTasks, selfCheckTask, findBenchTasksDir } from "../dist/sbce-bench.js";

const root = fileURLToPath(new URL("../bench/sbce/tasks/", import.meta.url));

test("real bench tasks load and the worker can find them", async () => {
  const { tasks, errors } = await loadBenchTasks(root);
  assert.deepEqual(errors, []);
  assert.equal(tasks.length, 15);
  const classes = tasks.reduce((m, t) => ({ ...m, [t.task.class]: (m[t.task.class] ?? 0) + 1 }), {});
  assert.deepEqual(classes, { bugfix: 3, feature: 3, doc: 5, judge: 4 });
  assert.ok(findBenchTasksDir(undefined, new URL("../dist/sbce-bench.js", import.meta.url).href));
});

test("every bench task is sound: workspace fails, solution passes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-self-"));
  try {
    const { tasks } = await loadBenchTasks(root);
    const problems = [];
    for (const t of tasks) problems.push(...(await selfCheckTask(t, dir)));
    assert.deepEqual(problems, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
