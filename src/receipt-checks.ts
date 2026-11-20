import { redact } from "./security.js";

export type ReceiptPreset = { expect_exit: number; expect_regex: string };
export const RECEIPT_CHECK_PRESETS: Readonly<Record<string, ReceiptPreset>> = Object.freeze({
  "npm-test": { expect_exit: 0, expect_regex: "^\\s*(?:#|ℹ)\\s*fail 0\\s*$" },
  "node-test": { expect_exit: 0, expect_regex: "^\\s*(?:#|ℹ)\\s*fail 0\\s*$" },
  "pytest": { expect_exit: 0, expect_regex: "\\b\\d+ passed\\b" },
  "kiem-format": { expect_exit: 0, expect_regex: "TỔNG: ĐẠT" },
});

export type ReceiptAuditRow = {
  at: string;
  action: string;
  detail: string | Record<string, unknown>;
};
export type ReceiptCheck = Record<string, unknown> & {
  cmd: string;
  cwd?: string;
  expect_exit?: number;
  expect_regex?: string;
  preset?: string;
};
export type ReceiptEvidence = {
  source: "harness" | "missing";
  ran_at?: string;
  exit_code?: number | null;
  timed_out?: boolean;
  output_tail?: string;
  passed: boolean;
};

export function normalizeReceiptCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}
export function normalizeReceiptCwd(cwd: string): string {
  return cwd.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

// Audit outputs are already redacted by TerminalService; re-sanitize before making them durable.
export function sanitizeReceiptOutput(output: string): string {
  return redact(output)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[private key removed]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, "Bearer [hidden]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[hidden]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh_[hidden]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[hidden]")
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/gi, "[url credentials removed]@");
}

export function verifyReceiptChecks(
  rawChecks: unknown,
  auditRows: readonly ReceiptAuditRow[],
  taskRunId?: string | null,
  now: Date = new Date(),
): { checks: Array<ReceiptCheck & { evidence: ReceiptEvidence }>; summary: { total: number; passed: number } } {
  if (rawChecks !== undefined && !Array.isArray(rawChecks)) throw new Error("Receipt checks must be an array.");
  const checks = (rawChecks ?? []) as unknown[];
  const cutoff = now.getTime() - 6 * 60 * 60 * 1000;
  const verified = checks.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid receipt check " + index);
    const check = raw as ReceiptCheck;
    if (typeof check.cmd !== "string" || !check.cmd.trim()) throw new Error("Receipt check " + index + " requires cmd.");
    if (check.cwd !== undefined && typeof check.cwd !== "string") throw new Error("Invalid cwd for check " + index);
    let preset: ReceiptPreset | undefined;
    if (check.preset !== undefined) {
      if (typeof check.preset !== "string" || !(check.preset in RECEIPT_CHECK_PRESETS))
        throw new Error("UNKNOWN_RECEIPT_PRESET: " + String(check.preset));
      preset = RECEIPT_CHECK_PRESETS[check.preset];
    }
    const expect_exit = check.expect_exit ?? preset?.expect_exit ?? 0;
    const expect_regex = check.expect_regex ?? preset?.expect_regex;
    if (!Number.isInteger(expect_exit)) throw new Error("Invalid expect_exit for check " + index);
    if (expect_regex !== undefined && typeof expect_regex !== "string") throw new Error("Invalid expect_regex for check " + index);
    const regex = expect_regex === undefined ? undefined : new RegExp(expect_regex, "m");
    const cmd = normalizeReceiptCommand(check.cmd);
    const cwd = check.cwd === undefined ? undefined : normalizeReceiptCwd(check.cwd);
    let evidence: ReceiptEvidence = { source: "missing", passed: false };
    for (const row of auditRows) {
      if (row.action !== "terminal_execute" && row.action !== "terminal_session_execute" && row.action !== "task_run_step") continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at)) continue;
      if (!taskRunId && at < cutoff) continue;
      let detail: Record<string, unknown>;
      try { detail = typeof row.detail === "string" ? JSON.parse(row.detail) as Record<string, unknown> : row.detail; }
      catch { continue; }
      if (!detail || typeof detail !== "object") continue;
      if (taskRunId && detail.taskRunId !== taskRunId) continue;
      // A task step may point to a real terminal execution, but its self-reported notes
      // alone cannot establish exit code or output. Only harness execution records qualify.
      if (row.action === "task_run_step" && detail.executionVerifiedByHarness !== true) continue;
      if (typeof detail.command !== "string" || normalizeReceiptCommand(detail.command) !== cmd) continue;
      if (cwd !== undefined && (typeof detail.cwd !== "string" || normalizeReceiptCwd(detail.cwd) !== cwd)) continue;
      const exit = typeof detail.code === "number" ? detail.code : null;
      const timedOut = detail.timedOut === true;
      const stdout = typeof detail.stdout === "string" ? detail.stdout : "";
      const stderr = typeof detail.stderr === "string" ? detail.stderr : "";
      const output = stdout + (stdout && stderr ? "\n" : "") + stderr;
      const safe = sanitizeReceiptOutput(output);
      const passed = exit === expect_exit && !timedOut && (regex === undefined || regex.test(output));
      evidence = { source: "harness", ran_at: String(detail.completedAt ?? row.at), exit_code: exit,
        timed_out: timedOut, output_tail: safe.slice(-2000), passed };
      break;
    }
    return { ...check, expect_exit, ...(expect_regex === undefined ? {} : { expect_regex }), evidence };
  });
  return { checks: verified, summary: { total: verified.length, passed: verified.filter(c => c.evidence.passed).length } };
}
