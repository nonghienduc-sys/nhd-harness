import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildContextPack, CONTEXT_BUDGET } from "../dist/sbce-context.js";
import { compactJob } from "../dist/sbce-compact.js";

test("context pack lists snippets cut to fit the budget", () => {
  const big = "x".repeat(9000);
  const p = buildContextPack([{ source: "a", locator: "a:1-300", snippet: big }, { source: "b", locator: "b:1-5", snippet: "short" }], CONTEXT_BUDGET.code.total, CONTEXT_BUDGET.code.perSnippet);
  assert.deepEqual(p.truncated, ["a:1-300"]);
  assert.equal(p.omitted, 0);
});

test("context pack reports nothing lost when everything fits", () => {
  const p = buildContextPack([{ source: "a", locator: "a:1-2", snippet: "ok" }]);
  assert.deepEqual(p.truncated, []);
  assert.equal(p.omitted, 0);
});

test("context pack counts evidence dropped once the total budget is spent", () => {
  const s = "y".repeat(2400);
  const p = buildContextPack([1, 2, 3, 4].map((i) => ({ source: "f" + i, locator: "f" + i + ":1", snippet: s })));
  assert.ok(p.omitted + p.truncated.length > 0);
});

test("compact receipt surfaces a context truncation warning only when present", () => {
  const warned = compactJob({ id: "j", status: "ready_for_review", review: { risks: ["Context pack truncated: 1 item(s) omitted. Worker saw partial context.", "Sandbox draft only; not applied."] } });
  assert.match(warned.context_warning, /^Context pack truncated/);
  assert.equal("context_warning" in compactJob({ id: "k", status: "accepted", review: { risks: ["Sandbox draft only; not applied."] } }), false);
});

test("facade and runner report truncation instead of dropping silently", () => {
  const facade = readFileSync(new URL("../src/mcp-registries/delegation-tools.ts", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../src/sbce-runner.ts", import.meta.url), "utf8");
  assert.match(facade, /context_report/);
  assert.match(runner, /plainRefs=order\.context_refs\.filter/);
  assert.equal((runner.match(/risks:\[\.\.\.ctxRisks,/g) ?? []).length, 4);
});
