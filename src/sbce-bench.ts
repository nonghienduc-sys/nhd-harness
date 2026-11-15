/** SBCE model benchmark: fixed tasks with hidden tests, run against each catalog model. Never touches jobs, budgets or the bandit. */
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { editBlocksToPatch } from "./sbce-edit-blocks.js";
import { defaultVerifyRunner, resolveNodeRunner, type VerifyRunner } from "./sbce-verify.js";
import { parsedJudge, type SbceGenerator } from "./sbce-runner.js";
import { actualChargeVnd } from "./sbce-budget.js";
import { codeOutputCeiling } from "./sbce-provider.js";
import type { SbceModel } from "./sbce-core.js";

export type BenchClass = "bugfix" | "feature" | "doc" | "judge";
export type DocChecks = {
  output_path: string;
  must_include?: string[];
  must_not_include?: string[];
  in_section?: Record<string, string[]>;
  max_chars?: number;
};
export type BenchTask = {
  id: string;
  class: BenchClass;
  difficulty: "easy" | "medium" | "hard";
  title: string;
  prompt: string;
  files: string[];
  tests?: string[];
  checks?: DocChecks;
  patch?: string;
  expected?: "accept" | "reject";
};
export type LoadedTask = { task: BenchTask; dir: string };
export type BenchResult = {
  taskId: string;
  class: BenchClass;
  difficulty: string;
  modelId: string;
  tier: string;
  run: number;
  passAt1: boolean;
  passAt2: boolean;
  correct?: boolean;
  error?: string;
  feedback?: string;
  tokensIn: number;
  tokensOut: number;
  costVnd: number;
  latencyMs: number;
  attempts: number;
  skipped?: boolean;
  truncated?: number;
};

export const BENCH_EDIT_FORMAT =
  "EDIT FORMAT: one or more blocks, each exactly:\nFILE: <relative/path>\n<<<<<<< SEARCH\n<exact existing lines, copied verbatim, enough to be unique>\n=======\n<replacement lines>\n>>>>>>> REPLACE\nNew file: empty SEARCH section. Source lines above are prefixed with 'NNNNN| ' line numbers: never copy the prefix. No line numbers, no diff syntax, no prose, no code fences. No deletes or renames.";
const CODER_SYSTEM = "You are a code patch author. Output SEARCH/REPLACE edit blocks only. Never claim that tests ran. No commands, no source edits.";
const WRITER_SYSTEM = "You are a technical writer. Output only the requested document text, ready to save as the file. No commentary before or after it.";
const JUDGE_SYSTEM = 'You are a strict code reviewer. Reply with JSON only, exactly {"pass": true|false, "reason": "<one short sentence>"}. pass is true only if the patch is correct and complete for the spec and does not weaken tests.';
const CLASSES: BenchClass[] = ["bugfix", "feature", "doc", "judge"];
const ID_RE = /^[a-z0-9-]{1,60}$/;

function safeRel(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length < 200 && !isAbsolute(path) && !path.split(/[\\/]+/).includes("..") && !/^[a-zA-Z]:/.test(path);
}
async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export function roleForClass(cls: BenchClass): "coder" | "writer" | "judge" {
  return cls === "doc" ? "writer" : cls === "judge" ? "judge" : "coder";
}

export async function loadBenchTasks(root: string): Promise<{ tasks: LoadedTask[]; errors: string[] }> {
  const tasks: LoadedTask[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try { names = (await readdir(root)).sort(); } catch { return { tasks, errors: ["SBCE_BENCH_TASKS_DIR_MISSING"] }; }
  for (const name of names) {
    const dir = join(root, name);
    if (!(await isFile(join(dir, "task.json")))) continue;
    try {
      const task = JSON.parse(await readFile(join(dir, "task.json"), "utf8")) as BenchTask;
      if (task.id !== name || !ID_RE.test(task.id)) throw Error("id must match folder");
      if (!CLASSES.includes(task.class)) throw Error("bad class");
      if (typeof task.prompt !== "string" || !task.prompt.trim()) throw Error("prompt required");
      if (!Array.isArray(task.files) || !task.files.length || !task.files.every(safeRel)) throw Error("bad files");
      for (const f of task.files) if (!(await isFile(join(dir, "workspace", f)))) throw Error(`missing workspace/${f}`);
      if (task.class === "bugfix" || task.class === "feature") {
        if (!Array.isArray(task.tests) || !task.tests.length || !task.tests.every(safeRel)) throw Error("bad tests");
        for (const t of task.tests) if (!(await isFile(join(dir, "tests", t)))) throw Error(`missing tests/${t}`);
      } else if (task.class === "doc") {
        if (!task.checks || !safeRel(task.checks.output_path)) throw Error("bad checks");
      } else {
        if (!safeRel(task.patch) || !(await isFile(join(dir, task.patch)))) throw Error("bad patch");
        if (task.expected !== "accept" && task.expected !== "reject") throw Error("bad expected");
      }
      tasks.push({ task, dir });
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  return { tasks, errors };
}

async function filesBlock(dir: string, files: string[], numbered: boolean): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    const text = (await readFile(join(dir, "workspace", f), "utf8")).replace(/\r\n/g, "\n");
    const body = numbered
      ? text.replace(/\n$/, "").split("\n").map((line, i) => String(i + 1).padStart(5, " ") + "| " + line).join("\n")
      : text;
    parts.push(`=== ${f} ===\n${body}`);
  }
  return parts.join("\n\n");
}

function tail(text: string, n: number): string {
  return text.length > n ? text.slice(-n) : text;
}

/** Deterministic checks for doc tasks. Returns the list of failures (empty = pass). */
export function docFailures(text: string, checks: DocChecks): string[] {
  const failures: string[] = [];
  for (const s of checks.must_include ?? []) if (!text.includes(s)) failures.push(`missing required text: ${JSON.stringify(s)}`);
  for (const s of checks.must_not_include ?? []) if (text.includes(s)) failures.push(`forbidden text present: ${JSON.stringify(s)}`);
  if (checks.max_chars && text.length > checks.max_chars) failures.push(`too long: ${text.length} > ${checks.max_chars} chars`);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const [heading, needles] of Object.entries(checks.in_section ?? {})) {
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start < 0) { failures.push(`section not found: ${heading}`); continue; }
    const level = (/^#+/.exec(heading)?.[0] ?? "#").length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#+)\s/.exec(lines[i]);
      if (m && m[1].length <= level) { end = i; break; }
    }
    const section = lines.slice(start + 1, end).join("\n");
    for (const s of needles) if (!section.includes(s)) failures.push(`${JSON.stringify(s)} must be under ${heading}`);
  }
  return failures;
}

/** Strip a fence that wraps the whole reply (```markdown ... ```), which many models add. */
export function unwrapDocument(text: string): string {
  const m = /^\s*```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text);
  return (m ? m[1] : text).trim() + "\n";
}

export type CodeRunOutcome = { ok: boolean; stage: "apply" | "tests" | "sandbox"; output: string };

/** Copy workspace into a temp dir, optionally apply a patch or overlay solution/, add hidden tests, run node --test. */
export async function runCodeInCopy(o: { dir: string; task: BenchTask; tmpRoot: string; patch?: string; overlaySolution?: boolean; runner?: VerifyRunner; timeoutMs?: number }): Promise<CodeRunOutcome> {
  const run = o.runner ?? defaultVerifyRunner;
  const timeoutMs = o.timeoutMs ?? 60000;
  await mkdir(o.tmpRoot, { recursive: true });
  const work = await mkdtemp(join(o.tmpRoot, "sbce-bench-"));
  const scratch = join(work, ".tmp");
  const node = resolveNodeRunner();
  const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...node.extraEnv, TEMP: scratch, TMP: scratch };
  try {
    await cp(join(o.dir, "workspace"), work, { recursive: true });
    await mkdir(scratch, { recursive: true });
    if (o.overlaySolution) await cp(join(o.dir, "solution"), work, { recursive: true, force: true });
    if (o.patch !== undefined) {
      await writeFile(join(work, ".bench.patch"), o.patch);
      const applied = await run("git", ["apply", "--whitespace=nowarn", ".bench.patch"], { cwd: work, timeoutMs, env });
      if (applied.code !== 0) return { ok: false, stage: "apply", output: tail(applied.output || `exit ${String(applied.code)}`, 1500) };
    }
    // Hidden tests are added only after the patch, so a patch can never edit them.
    await cp(join(o.dir, "tests"), join(work, "test"), { recursive: true, force: true });
    const tests = (o.task.tests ?? []).map((t) => `test/${t}`);
    const result = await run(node.cmd, ["--permission", `--allow-fs-read=${work}`, `--allow-fs-write=${work}`, "--test", "--test-isolation=none", ...tests], { cwd: work, timeoutMs, env });
    if (result.code !== 0 && /ERR_ACCESS_DENIED/.test(result.output)) return { ok: false, stage: "sandbox", output: tail(result.output, 1500) };
    return { ok: result.code === 0, stage: "tests", output: tail(result.output || `exit ${String(result.code)}`, 1500) };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function patchTouchesTests(patch: string): boolean {
  return /^(?:diff --git a\/|\+\+\+ b\/|--- a\/)(?:test|tests)\//m.test(patch);
}

function charge(model: SbceModel, input: number, output: number): number {
  try { return actualChargeVnd(input, output, model.vndPerM, model.minVndPerCall); } catch { return Math.ceil(((input + output) * Math.max(0, model.vndPerM || 0)) / 1_000_000); }
}

type Call = { text: string; input: number; output: number; costVnd: number; ms: number; truncated: boolean };
const TRUNCATED_NOTE = "Your reply was cut off at the output limit before it finished. Use the smallest unique SEARCH sections and never rewrite whole files. ";
async function callModel(generator: SbceGenerator, model: SbceModel, system: string, prompt: string, maxTokens: number, timeoutMs: number): Promise<Call> {
  const started = Date.now();
  const r = await generator.generate({ model, system, prompt, maxTokens, timeoutMs });
  const input = Number.isSafeInteger(r.usage?.input) && r.usage.input >= 0 ? r.usage.input : Math.ceil((system.length + prompt.length) / 4);
  const output = Number.isSafeInteger(r.usage?.output) && r.usage.output >= 0 ? r.usage.output : Math.ceil((r.text ?? "").length / 4);
  return { text: String(r.text ?? ""), input, output, costVnd: charge(model, input, output), ms: Date.now() - started, truncated: r.truncated === true };
}

export async function runBenchTask(o: { task: BenchTask; dir: string; model: SbceModel; generator: SbceGenerator; tmpRoot: string; run?: number; runner?: VerifyRunner; callTimeoutMs?: number }): Promise<BenchResult> {
  const { task, dir, model } = o;
  const res: BenchResult = { taskId: task.id, class: task.class, difficulty: task.difficulty, modelId: model.id, tier: model.tier, run: o.run ?? 1, passAt1: false, passAt2: false, tokensIn: 0, tokensOut: 0, costVnd: 0, latencyMs: 0, attempts: 0 };
  const timeoutMs = o.callTimeoutMs ?? 120000;
  const add = (c: Call) => { res.tokensIn += c.input; res.tokensOut += c.output; res.costVnd += c.costVnd; res.latencyMs += c.ms; res.attempts++; };
  try {
    if (task.class === "judge") {
      const patch = await readFile(join(dir, task.patch!), "utf8");
      const prompt = `${task.prompt}\n\nCURRENT FILES:\n${await filesBlock(dir, task.files, false)}\n\nPATCH:\n${patch}`;
      const c = await callModel(o.generator, model, JUDGE_SYSTEM, prompt, 600, timeoutMs);
      add(c);
      const verdict = parsedJudge(c.text);
      const structured = verdict.reason !== "SBCE_JUDGE_UNSTRUCTURED";
      res.correct = structured && verdict.pass === (task.expected === "accept");
      res.passAt1 = res.passAt2 = res.correct;
      if (!structured) res.error = "SBCE_JUDGE_UNSTRUCTURED";
      res.feedback = `verdict=${structured ? (verdict.pass ? "accept" : "reject") : "unstructured"}; ${verdict.reason}`.slice(0, 300);
      return res;
    }
    if (task.class === "doc") {
      const checks = task.checks!;
      const base = `${task.prompt}\n\nSOURCE FILES:\n${await filesBlock(dir, task.files, false)}\n\nReply with the full content of ${checks.output_path} only.`;
      let prompt = base;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const c = await callModel(o.generator, model, WRITER_SYSTEM, prompt, 3000, timeoutMs);
        add(c);
        if (c.truncated) res.truncated = (res.truncated ?? 0) + 1;
        const failures = docFailures(unwrapDocument(c.text), checks);
        if (!failures.length) { if (attempt === 1) res.passAt1 = true; res.passAt2 = true; return res; }
        res.feedback = failures.join("; ").slice(0, 600);
        prompt = `${base}\n\nYOUR PREVIOUS REPLY:\n${c.text.slice(0, 6000)}\n\nIT FAILED THESE CHECKS:\n${failures.join("\n").slice(0, 1500)}\n\nReply again with the corrected full document only.`;
      }
      return res;
    }
    // bugfix / feature
    const workspaceText = new Map<string, string>();
    for (const f of task.files) workspaceText.set(f, (await readFile(join(dir, "workspace", f), "utf8")).replace(/\r\n/g, "\n"));
    const base = `${task.prompt}\n\nFILES:\n${await filesBlock(dir, task.files, true)}\n\n${BENCH_EDIT_FORMAT}`;
    let prompt = base;
    let maxTokens = codeOutputCeiling(model);
    for (let attempt = 1; attempt <= 2; attempt++) {
      let c: Call;
      try {
        c = await callModel(o.generator, model, CODER_SYSTEM, prompt, maxTokens, timeoutMs);
      } catch (e) {
        // Empty reply cut at the output ceiling: retry once with the larger ceiling.
        if (attempt === 1 && /SBCE_PROVIDER_OUTPUT_TRUNCATED/.test(e instanceof Error ? e.message : String(e))) {
          res.truncated = (res.truncated ?? 0) + 1; res.feedback = "SBCE_PROVIDER_OUTPUT_TRUNCATED"; maxTokens = 8192; continue;
        }
        throw e;
      }
      add(c);
      if (c.truncated) { res.truncated = (res.truncated ?? 0) + 1; maxTokens = 8192; }
      let feedback = "";
      const converted = editBlocksToPatch(c.text, (p) => workspaceText.get(p) ?? null);
      if (!converted.ok) feedback = `${c.truncated ? TRUNCATED_NOTE : ""}Edit blocks rejected: ${converted.errors.join("; ")}`;
      else if (patchTouchesTests(converted.patch)) feedback = "Edits to test files are not allowed.";
      else {
        const outcome = await runCodeInCopy({ dir, task, tmpRoot: o.tmpRoot, patch: converted.patch, runner: o.runner });
        if (outcome.stage === "sandbox") { res.error = "SBCE_BENCH_SANDBOX"; res.feedback = outcome.output.slice(-300); return res; }
        if (outcome.ok) { if (attempt === 1) res.passAt1 = true; res.passAt2 = true; return res; }
        feedback = outcome.stage === "apply" ? `Patch does not apply: ${outcome.output}` : `Hidden tests failed:\n${outcome.output}`;
      }
      res.feedback = feedback.slice(-600);
      prompt = `${base}\n\nYOUR PREVIOUS REPLY:\n${c.text.slice(0, 6000)}\n\nPROBLEM:\n${tail(feedback, 1500)}\n\nReply again with corrected edit blocks. SEARCH must match the ORIGINAL files shown above.`;
    }
    return res;
  } catch (e) {
    res.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return res;
  }
}

/** A sound task: workspace must fail its hidden tests and solution/ must pass them (doc: solution passes checks). */
export async function selfCheckTask(t: LoadedTask, tmpRoot: string, runner?: VerifyRunner): Promise<string[]> {
  const problems: string[] = [];
  const { task, dir } = t;
  if (task.class === "bugfix" || task.class === "feature") {
    const before = await runCodeInCopy({ dir, task, tmpRoot, runner });
    if (before.ok) problems.push(`${task.id}: workspace already passes the tests`);
    if (before.stage === "sandbox") problems.push(`${task.id}: sandbox blocked the workspace run`);
    const after = await runCodeInCopy({ dir, task, tmpRoot, runner, overlaySolution: true });
    if (!after.ok) problems.push(`${task.id}: solution fails: ${after.output.slice(-400)}`);
  } else if (task.class === "doc") {
    const file = join(dir, "solution", task.checks!.output_path);
    if (!(await isFile(file))) problems.push(`${task.id}: missing solution/${task.checks!.output_path}`);
    else {
      const f = docFailures(await readFile(file, "utf8"), task.checks!);
      if (f.length) problems.push(`${task.id}: solution fails checks: ${f.join("; ")}`);
    }
  }
  return problems;
}

export type BenchState = {
  runId: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  planned: number;
  completed: number;
  skipped: number;
  spentVnd: number;
  budgetVnd: number;
  stoppedReason?: string;
  results: BenchResult[];
};

export function createBenchRun(o: { tasks: LoadedTask[]; models: SbceModel[]; generator: SbceGenerator; outDir: string; tmpRoot: string; runs?: number; budgetVnd?: number; concurrency?: number; runner?: VerifyRunner; now?: () => Date }) {
  const now = o.now ?? (() => new Date());
  const runs = Math.max(1, Math.min(3, Math.floor(o.runs ?? 2)));
  const budgetVnd = Math.max(1, o.budgetVnd ?? 15000);
  const concurrency = Math.max(1, Math.min(3, Math.floor(o.concurrency ?? 2)));
  const plan: { t: LoadedTask; model: SbceModel; run: number }[] = [];
  for (let run = 1; run <= runs; run++)
    for (const t of o.tasks)
      for (const model of o.models) if (model.roles.includes(roleForClass(t.task.class))) plan.push({ t, model, run });
  const runId = "bench-" + now().toISOString().replace(/[:.]/g, "-");
  const state: BenchState = { runId, status: "running", startedAt: now().toISOString(), planned: plan.length, completed: 0, skipped: 0, spentVnd: 0, budgetVnd, results: [] };
  const jsonl = join(o.outDir, `${runId}.jsonl`);
  const promise = (async () => {
    await mkdir(o.outDir, { recursive: true });
    let next = 0;
    const worker = async () => {
      while (next < plan.length) {
        const item = plan[next++];
        let r: BenchResult;
        if (state.spentVnd >= budgetVnd) {
          r = { taskId: item.t.task.id, class: item.t.task.class, difficulty: item.t.task.difficulty, modelId: item.model.id, tier: item.model.tier, run: item.run, passAt1: false, passAt2: false, tokensIn: 0, tokensOut: 0, costVnd: 0, latencyMs: 0, attempts: 0, skipped: true };
          state.skipped++;
          state.stoppedReason = "SBCE_BENCH_BUDGET_REACHED";
        } else {
          r = await runBenchTask({ task: item.t.task, dir: item.t.dir, model: item.model, generator: o.generator, tmpRoot: o.tmpRoot, run: item.run, runner: o.runner });
          state.spentVnd += r.costVnd;
          state.completed++;
        }
        state.results.push(r);
        await appendFile(jsonl, JSON.stringify(r) + "\n", "utf8");
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    state.status = "done";
    state.finishedAt = now().toISOString();
    const summary = summarizeBench(state.results, o.models);
    await writeFile(join(o.outDir, `${runId}.summary.json`), JSON.stringify({ ...stateHeader(state), summary }, null, 2), "utf8");
  })().catch(async (e) => {
    state.status = "failed";
    state.finishedAt = now().toISOString();
    state.stoppedReason = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  });
  return { state, planned: plan.length, promise };
}

export function stateHeader(s: BenchState) {
  return { runId: s.runId, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, planned: s.planned, completed: s.completed, skipped: s.skipped, spentVnd: s.spentVnd, budgetVnd: s.budgetVnd, stoppedReason: s.stoppedReason };
}

type ClassStat = { n: number; pass1: number; pass2: number; rate1: number | null; rate2: number | null; costVnd: number };
export type ModelSummary = { modelId: string; tier: string; family: string; n: number; passAt1Rate: number | null; passAt2Rate: number | null; byClass: Partial<Record<BenchClass, ClassStat>>; totalCostVnd: number; avgLatencyMs: number | null; errors: number; errorKinds: Record<string, number> };

export function summarizeBench(results: BenchResult[], models: SbceModel[]) {
  const pct = (x: number, n: number) => (n ? Math.round((x / n) * 1000) / 10 : null);
  const byModel = new Map<string, BenchResult[]>();
  for (const r of results) if (!r.skipped) byModel.set(r.modelId, [...(byModel.get(r.modelId) ?? []), r]);
  const catalog = new Map(models.map((m) => [m.id, m]));
  const rows: ModelSummary[] = [];
  for (const [modelId, list] of byModel) {
    const byClass: Partial<Record<BenchClass, ClassStat>> = {};
    for (const cls of CLASSES) {
      const xs = list.filter((r) => r.class === cls);
      if (!xs.length) continue;
      const p1 = xs.filter((r) => r.passAt1).length, p2 = xs.filter((r) => r.passAt2).length;
      byClass[cls] = { n: xs.length, pass1: p1, pass2: p2, rate1: pct(p1, xs.length), rate2: pct(p2, xs.length), costVnd: xs.reduce((s, r) => s + r.costVnd, 0) };
    }
    const errorKinds: Record<string, number> = {};
    for (const r of list) if (r.error) { const k = r.error.split(/[:\s]/)[0].slice(0, 60); errorKinds[k] = (errorKinds[k] ?? 0) + 1; }
    const timed = list.filter((r) => r.attempts > 0);
    rows.push({
      modelId, tier: catalog.get(modelId)?.tier ?? "?", family: catalog.get(modelId)?.family ?? "?", n: list.length,
      passAt1Rate: pct(list.filter((r) => r.passAt1).length, list.length), passAt2Rate: pct(list.filter((r) => r.passAt2).length, list.length),
      byClass, totalCostVnd: list.reduce((s, r) => s + r.costVnd, 0),
      avgLatencyMs: timed.length ? Math.round(timed.reduce((s, r) => s + r.latencyMs / r.attempts, 0) / timed.length) : null,
      errors: list.filter((r) => r.error).length, errorKinds,
    });
  }
  const ranking: Partial<Record<BenchClass, { modelId: string; tier: string; n: number; rate1: number | null; rate2: number | null; costVnd: number }[]>> = {};
  for (const cls of CLASSES) {
    const xs = rows.filter((m) => m.byClass[cls]).map((m) => ({ modelId: m.modelId, tier: m.tier, ...m.byClass[cls]! }));
    if (!xs.length) continue;
    xs.sort((a, b) => (b.rate2 ?? 0) - (a.rate2 ?? 0) || (b.rate1 ?? 0) - (a.rate1 ?? 0) || a.costVnd - b.costVnd || a.modelId.localeCompare(b.modelId));
    ranking[cls] = xs.map(({ modelId, tier, n, rate1, rate2, costVnd }) => ({ modelId, tier, n, rate1, rate2, costVnd }));
  }
  rows.sort((a, b) => (b.passAt2Rate ?? 0) - (a.passAt2Rate ?? 0) || a.totalCostVnd - b.totalCostVnd);
  return { models: rows, ranking, totalCostVnd: rows.reduce((s, m) => s + m.totalCostVnd, 0) };
}

export function findBenchTasksDir(override: string | undefined, importMetaUrl: string): string | null {
  if (override) return resolve(override);
  let d = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 6; i++) {
    const candidate = join(d, "bench", "sbce", "tasks");
    if (existsSync(candidate)) return candidate;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

export async function listBenchRuns(outDir: string): Promise<{ runId: string; hasSummary: boolean }[]> {
  let names: string[] = [];
  try { names = await readdir(outDir); } catch { return []; }
  const ids = [...new Set(names.filter((n) => /^bench-[0-9TZ-]+\.jsonl$/.test(n)).map((n) => n.replace(/\.jsonl$/, "")))].sort().reverse().slice(0, 20);
  return ids.map((runId) => ({ runId, hasSummary: names.includes(`${runId}.summary.json`) }));
}

export async function readBenchSummary(outDir: string, runId: string): Promise<unknown> {
  if (!/^bench-[0-9TZ-]{10,40}$/.test(runId)) throw Error("SBCE_BENCH_RUN_ID_INVALID");
  const file = join(outDir, `${runId}.summary.json`);
  if (await isFile(file)) return JSON.parse(await readFile(file, "utf8"));
  const jsonl = join(outDir, `${runId}.jsonl`);
  if (!(await isFile(jsonl))) throw Error("SBCE_BENCH_RUN_NOT_FOUND");
  const results = (await readFile(jsonl, "utf8")).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as BenchResult);
  return { runId, status: "partial", summary: summarizeBench(results, []) };
}
