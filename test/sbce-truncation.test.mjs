import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HhtechProvider } from "../dist/sbce-provider.js";
import { loadBenchTasks, runBenchTask } from "../dist/sbce-bench.js";

const pModel = (protocol = "openai") => ({ id: "m", model: "test-model", provider: "hhtech", protocol, family: "test", tier: "T1", roles: ["coder"], enabled: true, vndPerM: 350 });
const reply = (body) => async () => new Response(JSON.stringify(body), { status: 200 });

test("provider flags replies cut at the output ceiling", async () => {
  const cut = new HhtechProvider(async () => "private-test-key-123", reply({ choices: [{ message: { content: "FILE: a\n<<<<<<< SEARCH" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 9 } }));
  assert.equal((await cut.generate({ model: pModel(), system: "s", prompt: "p", maxTokens: 10 })).truncated, true);
  const done = new HhtechProvider(async () => "private-test-key-123", reply({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  assert.equal((await done.generate({ model: pModel(), system: "s", prompt: "p", maxTokens: 10 })).truncated, false);
  const anth = new HhtechProvider(async () => "private-test-key-123", reply({ content: [{ type: "text", text: "half" }], stop_reason: "max_tokens", usage: { input_tokens: 5, output_tokens: 10 } }));
  assert.equal((await anth.generate({ model: pModel("anthropic"), system: "s", prompt: "p", maxTokens: 10 })).truncated, true);
  const empty = new HhtechProvider(async () => "private-test-key-123", reply({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 10 } }));
  await assert.rejects(empty.generate({ model: pModel(), system: "s", prompt: "p", maxTokens: 10 }), /SBCE_PROVIDER_OUTPUT_TRUNCATED/);
});

const fixtures = fileURLToPath(new URL("./fixtures/sbce-bench/", import.meta.url));
const bModel = { id: "g", model: "g", provider: "hhtech", protocol: "openai", family: "g", tier: "T1", roles: ["coder"], enabled: true, vndPerM: 10000 };
const GOOD_EDIT = "FILE: src/add.mjs\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\nexport const add = (a, b) => a + b;\n>>>>>>> REPLACE\n";
function gen(replies) {
  const calls = [];
  return { calls, generate: async (input) => {
    calls.push(input);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return { text: next.text, truncated: next.truncated, usage: { input: 100, output: 20, cached: 0 }, model: "g", protocol: "openai" };
  } };
}

test("bench retries a truncated edit reply with the larger ceiling and says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trunc-test-"));
  try {
    const t = (await loadBenchTasks(fixtures)).tasks.find((x) => x.task.id === "t-add");
    const g = gen([{ text: "FILE: src/add.mjs\n<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\nexport const add", truncated: true }, { text: GOOD_EDIT, truncated: false }]);
    const r = await runBenchTask({ ...t, model: bModel, generator: g, tmpRoot: dir });
    assert.equal(r.passAt1, false);
    assert.equal(r.passAt2, true);
    assert.equal(r.truncated, 1);
    assert.equal(g.calls[0].maxTokens, 4096);
    assert.equal(g.calls[1].maxTokens, 8192);
    assert.match(g.calls[1].prompt, /cut off at the output limit/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bench retries once when the provider returns an empty truncated reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trunc-test-"));
  try {
    const t = (await loadBenchTasks(fixtures)).tasks.find((x) => x.task.id === "t-add");
    const g = gen([new Error("SBCE_PROVIDER_OUTPUT_TRUNCATED"), { text: GOOD_EDIT, truncated: false }]);
    const r = await runBenchTask({ ...t, model: bModel, generator: g, tmpRoot: dir });
    assert.equal(r.error, undefined);
    assert.equal(r.passAt2, true);
    assert.equal(r.truncated, 1);
    assert.equal(g.calls[1].maxTokens, 8192);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("gemini starts code edits at the larger ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trunc-test-"));
  try {
    const t = (await loadBenchTasks(fixtures)).tasks.find((x) => x.task.id === "t-add");
    const g = gen([{ text: GOOD_EDIT, truncated: false }]);
    const r = await runBenchTask({ ...t, model: { ...bModel, family: "gemini" }, generator: g, tmpRoot: dir });
    assert.equal(r.passAt1, true);
    assert.equal(g.calls[0].maxTokens, 8192);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
