import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../scripts/claude-brain-mode-hook.mjs";

test("direct mode allows everything", () => {
  assert.equal(decide("Write", { file_path: "D:/x.ts" }, "direct").allow, true);
  assert.equal(decide("Bash", { command: "rm -rf x" }, "direct").allow, true);
});

test("harness denies Write to D:/x.ts", () => {
  const result = decide("Write", { file_path: "D:/x.ts" }, "harness");
  assert.equal(result.allow, false);
});

test("harness allows Write under C:/Users/ADMIN/.claude/memory/a.md", () => {
  const result = decide(
    "Write",
    { file_path: "C:/Users/ADMIN/.claude/memory/a.md" },
    "harness",
  );
  assert.equal(result.allow, true);
});

test("harness allows Read", () => {
  const result = decide("Read", { file_path: "D:/x.ts" }, "harness");
  assert.equal(result.allow, true);
});

test("harness allows 'git status && npm run build'", () => {
  const result = decide("Bash", { command: "git status && npm run build" }, "harness");
  assert.equal(result.allow, true);
});

test("harness denies 'rm -rf x'", () => {
  const result = decide("Bash", { command: "rm -rf x" }, "harness");
  assert.equal(result.allow, false);
});

test("harness denies 'git status; rm x'", () => {
  const result = decide("Bash", { command: "git status; rm x" }, "harness");
  assert.equal(result.allow, false);
});

test("harness denies 'cat a | python evil.py'", () => {
  const result = decide("Bash", { command: "cat a | python evil.py" }, "harness");
  assert.equal(result.allow, false);
});

test("harness hardening: redirection, substitution, loose prefixes, mode tampering", () => {
  for (const command of [
    "cat a > src/x.ts",
    "echo hi >> f",
    "ls $(rm -rf x)",
    "cat `whoami`",
    "cdx",
    "curl -s http://127.0.0.1.evil.com/x",
    "curl -s http://127.0.0.1:39100/api/brain-mode -d '{\"mode\":\"direct\"}'",
    "curl -s -X POST http://127.0.0.1:39100/api/x",
    "cat runtime/brain-mode.json",
  ]) assert.equal(decide("Bash", { command }, "harness").allow, false, command);
  for (const command of [
    "curl -s http://127.0.0.1:39100/api/sbce/jobs",
    "git apply --whitespace=nowarn p.patch",
    "node --test test/a.test.mjs",
    "cd D:/x && git status",
  ]) assert.equal(decide("Bash", { command }, "harness").allow, true, command);
});

test("self mode allows tools but blocks delegation", () => {
  assert.equal(decide("Write", { file_path: "D:/x.ts" }, "self").allow, true);
  assert.equal(decide("Bash", { command: "npm test" }, "self").allow, true);
  assert.equal(decide("mcp__abc__delegate_task", { action: "run" }, "self").allow, false);
  assert.equal(decide("mcp__abc__delegate_task", { action: "submit" }, "self").allow, false);
  assert.equal(decide("mcp__abc__delegate_task", { action: "status" }, "self").allow, true);
  assert.equal(decide("mcp__abc__delegate_task", { action: "run" }, "direct").allow, true);
});
