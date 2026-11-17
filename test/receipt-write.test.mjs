import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { receiptWrite, updateTimeLedger, receiptStaleWarnings, LEDGER_COLUMNS } from "../dist/receipt-write.js";

function sandbox(fn) {
  const root = mkdtempSync(join(tmpdir(), "nhd-receipt-"));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("receipt_write seals sha256 exactly, UTF-8 no BOM and preserves other metadata", () => sandbox((root) => {
  const file = join(root, "product.txt"), output = join(root, "receipt.json");
  writeFileSync(file, "hello world", "utf8");
  const hash = createHash("sha256").update("hello world").digest("hex");
  const result = receiptWrite({
    path: output, receipt: { task: "Demo", status: "completed", files: [{ path: file, sha256: "wrong", must_contain: ["hello"] }] },
    taskRunId: "task-example", taskStartedAt: "2026-01-01T09:00:00.000Z",
    now: () => new Date("2026-01-01T09:01:00.000Z")
  });
  const raw = readFileSync(output);
  assert.equal(raw[0], "{".charCodeAt(0));
  const saved = JSON.parse(raw.toString("utf8"));
  assert.equal(saved.files[0].sha256, hash);
  assert.deepEqual(saved.files[0].must_contain, ["hello"]);
  assert.equal(saved.task_run_id, "task-example");
  assert.equal(saved.sealed_at, "2026-01-01T09:01:00.000Z");
  assert.equal(result.files, 1);
}));

test("receipt_write fails when a file is missing", () => sandbox((root) => {
  assert.throws(() => receiptWrite({ path: join(root, "receipt.json"), receipt: { task: "x", files: [{ path: join(root, "missing.txt") }] } }), /RECEIPT_FILE_MISSING/);
}));

test("receipt_write rejects credential-looking keys and secret values", () => sandbox((root) => {
  const file = join(root, "product.txt");
  writeFileSync(file, "safe");
  assert.throws(() => receiptWrite({ path: join(root, "a.json"), receipt: { task: "a", files: [{ path: file }], apiKey: "some value" } }), /RECEIPT_SECRET_BLOCKED/);
  assert.throws(() => receiptWrite({ path: join(root, "b.json"), receipt: { task: "s" + "k" + "-ABCDEFGHIJKLMNOPQ", files: [{ path: file }] } }), /RECEIPT_SECRET_BLOCKED/);
}));

test("RECEIPT_STALE is raised only inside the sealing task after subsequent modification", () => sandbox((root) => {
  const file = join(root, "product.txt"); writeFileSync(file, "v1");
  receiptWrite({ path: join(root, "receipt.json"), receipt: { task: "stale", files: [{ path: file }] }, taskRunId: "task-stale-unit" });
  assert.deepEqual(receiptStaleWarnings("task-stale-unit"), []);
  writeFileSync(file, "v2-new");
  const warnings = receiptStaleWarnings("task-stale-unit");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("RECEIPT_STALE: "));
  assert.deepEqual(receiptStaleWarnings("task-other"), []);
}));

test("time ledger appends row with exact columns", () => sandbox((root) => {
  const file = join(root, "ledger.csv");
  updateTimeLedger(file, "Phiếu 1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z");
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
  assert.equal(lines[0], LEDGER_COLUMNS.join(","));
  const cells = lines[1].split(",");
  assert.equal(cells[1], "Phiếu 1");
  assert.equal(cells[7], "5.00");
  assert.equal(cells[8], "XONG");
}));

test("time ledger fills existing unfinished row and preserves BOM and unrelated rows verbatim", () => sandbox((root) => {
  const file = join(root, "ledger.csv");
  const header = LEDGER_COLUMNS.join(",");
  const old = "2026-01-01,Other,,,,09:00,10:00,60,XONG,,,,,";
  const open = "2026-01-01,Phiếu 2,,,,,,,,,,,,";
  const source = "\uFEFF" + header + "\r\n" + old + "\r\n" + open + "\r\n";
  writeFileSync(file, source, "utf8");
  updateTimeLedger(file, "Phiếu 2", "2026-01-01T01:00:00.000Z", "2026-01-01T01:10:00.000Z");
  const result = readFileSync(file, "utf8");
  assert.ok(result.startsWith("\uFEFF" + header + "\r\n" + old + "\r\n"));
  const rows = result.split("\r\n").filter(Boolean);
  assert.equal(rows.length, 3);
  const updated = rows[2].split(",");
  assert.equal(updated[1], "Phiếu 2");
  assert.equal(updated[6], "2026-01-01T01:10:00.000Z");
  assert.equal(updated[7], "10.00");
  assert.equal(updated[8], "XONG");
}));
