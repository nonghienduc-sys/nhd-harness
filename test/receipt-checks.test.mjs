import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptWrite } from "../dist/receipt-write.js";
import { RECEIPT_CHECK_PRESETS, verifyReceiptChecks } from "../dist/receipt-checks.js";

const now = new Date("2026-11-21T00:00:00Z");
const cwd = "D:\\ChatGPT-Workstation-MCP";
function audit({ cmd = "npm test", code = 0, stdout = "ℹ fail 0\n", at = now.toISOString(),
                 taskRunId = "task-unit-A", action = "terminal_execute", timedOut = false, where = cwd } = {}) {
  return { at, action, detail: JSON.stringify({ taskRunId, command: cmd, cwd: where,
    code, timedOut, stdout, stderr: "", completedAt: at }) };
}
function sandbox(fn) {
  const root = mkdtempSync(join(tmpdir(), "nhd-receipt-evidence-"));
  try {
    const product = join(root, "product.txt"), output = join(root, "receipt.json");
    writeFileSync(product, "product", "utf8");
    return fn({ product, output, root });
  } finally { rmSync(root, { force: true, recursive: true }); }
}
function seal(paths, checks, rows, opts = {}) {
  return receiptWrite({
    path: paths.output, taskRunId: opts.taskRunId === undefined ? "task-unit-A" : opts.taskRunId,
    receipt: { task: "A", files: [{ path: paths.product }], ...opts.receipt, checks },
    auditRows: rows, now: () => now,
  });
}
test("real harness evidence, whitespace/cwd normalization, summary and sha256 are sealed", () => sandbox((paths) => {
  seal(paths, [{ cmd: " npm   test  ", cwd: "d:/CHATGPT-workstation-mcp/", preset: "npm-test" }], [audit()]);
  const result = JSON.parse(readFileSync(paths.output, "utf8"));
  assert.equal(result.checks_verified_by, "harness");
  assert.deepEqual(result.checks_summary, { total: 1, passed: 1 });
  assert.equal(result.checks[0].evidence.source, "harness");
  assert.equal(result.checks[0].evidence.exit_code, 0);
  assert.equal(result.checks[0].evidence.timed_out, false);
  assert.equal(result.checks[0].evidence.ran_at, now.toISOString());
  assert.match(result.files[0].sha256, /^[a-f0-9]{64}$/);
}));
test("missing evidence blocks completed receipt, without creating a file", () => sandbox((paths) => {
  assert.throws(() => seal(paths, [{ cmd: "npm test", cwd }], []), /RECEIPT_CHECKS_FAILED.*missing harness evidence/);
  assert.equal(existsSync(paths.output), false);
}));
test("nonzero exit code and timeout block completed, latest execution takes priority", () => sandbox((paths) => {
  assert.throws(() => seal(paths, [{ cmd: "npm test", cwd }],
    [audit({ code: 1, stdout: "fail 1" }), audit({ code: 0 })]), /RECEIPT_CHECKS_FAILED.*exit=1/);
  assert.equal(existsSync(paths.output), false);
  assert.throws(() => seal(paths, [{ cmd: "npm test", cwd }], [audit({ timedOut: true })]), /RECEIPT_CHECKS_FAILED.*timeout=true/);
}));
test("KET/failed/blocked receipts are sealed with failed or missing evidence", () => sandbox((paths) => {
  seal(paths, [{ cmd: "npm test" }], [], { receipt: { status: "KET" } });
  assert.deepEqual(JSON.parse(readFileSync(paths.output, "utf8")).checks_summary, { total: 1, passed: 0 });
  seal(paths, [{ cmd: "npm test" }], [audit({ code: 12 })], { receipt: { status: "failed" } });
  assert.equal(JSON.parse(readFileSync(paths.output, "utf8")).checks[0].evidence.exit_code, 12);
  seal(paths, [{ cmd: "npm test" }], [], { receipt: { status: "blocked" } });
  seal(paths, [{ cmd: "npm test" }], [], { receipt: { trang_thai: "KET" } });
}));
test("npm-test and node-test presets accept #/ℹ fail 0 but reject fail 1", () => {
  for (const preset of ["npm-test", "node-test"]) {
    for (const stdout of ["# fail 0\n", "ℹ fail 0\n"]) {
      const result = verifyReceiptChecks([{ cmd: "npm test", preset }], [audit({ stdout })], "task-unit-A", now);
      assert.equal(result.summary.passed, 1);
    }
    const wrong = verifyReceiptChecks([{ cmd: "npm test", preset }], [audit({ stdout: "ℹ fail 1\n" })], "task-unit-A", now);
    assert.equal(wrong.summary.passed, 0);
  }
  assert.equal(RECEIPT_CHECK_PRESETS.pytest.expect_regex, "\\b\\d+ passed\\b");
  assert.equal(RECEIPT_CHECK_PRESETS["kiem-format"].expect_regex, "TỔNG: ĐẠT");
});
test("preset unknown throws even for blocked receipt; preset allows explicit expect_regex override", () => sandbox((paths) => {
  assert.throws(() => seal(paths, [{ cmd: "npm test", preset: "not-known" }], [], { receipt: { status: "KET" } }), /UNKNOWN_RECEIPT_PRESET/);
  assert.equal(existsSync(paths.output), false);
  const verified = verifyReceiptChecks([{ cmd: "npm test", preset: "npm-test", expect_regex: "hello" }],
    [audit({ stdout: "hello" })], "task-unit-A", now);
  assert.equal(verified.summary.passed, 1);
}));
test("output_tail is limited to 2000 chars and redacts secrets", () => sandbox((paths) => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345";
  const bearer = "Bearer 1234567890abcdefghijklmnop";
  seal(paths, [{ cmd: "npm test", expect_exit: 0 }],
    [audit({ stdout: "start\n" + "a".repeat(3000) + "\n" + secret + "\n" + bearer + "\npassword=unsafe987654321" })]);
  const evidence = JSON.parse(readFileSync(paths.output, "utf8")).checks[0].evidence;
  assert.ok(evidence.output_tail.length <= 2000);
  assert.ok(!evidence.output_tail.includes(secret));
  assert.ok(!evidence.output_tail.includes(bearer));
  assert.ok(!evidence.output_tail.includes("unsafe987654321"));
}));
test("task scope excludes other runs, and no-task scope expires after six hours", () => {
  const other = audit({ taskRunId: "task-not-mine" });
  assert.equal(verifyReceiptChecks([{ cmd: "npm test" }], [other], "task-unit-A", now).summary.passed, 0);
  const stale = audit({ at: "2026-11-20T17:59:59Z" });
  assert.equal(verifyReceiptChecks([{ cmd: "npm test" }], [stale], null, now).summary.passed, 0);
  const fresh = audit({ at: "2026-11-20T18:00:01Z" });
  assert.equal(verifyReceiptChecks([{ cmd: "npm test" }], [fresh], null, now).summary.passed, 1);
});
test("task_run_step metadata alone is never falsely treated as execution evidence", () => {
  assert.equal(verifyReceiptChecks([{ cmd: "npm test" }],
    [audit({ action: "task_run_step" })], "task-unit-A", now).summary.passed, 0);
});
