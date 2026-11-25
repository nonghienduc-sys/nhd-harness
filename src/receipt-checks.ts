import { win32 } from "node:path";
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

// Internal audit facts are kept separate from the public, bounded receipt evidence.
type PageAudit = { command: string; output: string; startedAt: unknown; completedAt: unknown };
export function verifyReceiptChecks(
  rawChecks: unknown,
  auditRows: readonly ReceiptAuditRow[],
  taskRunId?: string | null,
  now: Date = new Date(),
  pageAudit?: Map<number, PageAudit>,
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
      pageAudit?.set(index, { command: detail.command, output, startedAt: detail.startedAt, completedAt: detail.completedAt ?? row.at });
      evidence = { source: "harness", ran_at: String(detail.completedAt ?? row.at), exit_code: exit,
        timed_out: timedOut, output_tail: safe.slice(-2000), passed };
      break;
    }
    return { ...check, expect_exit, ...(expect_regex === undefined ? {} : { expect_regex }), evidence };
  });
  return { checks: verified, summary: { total: verified.length, passed: verified.filter(c => c.evidence.passed).length } };
}

type PageMode = "kiem" | "so";
type PageCommand = { mode: PageMode; target: string };
function absoluteWindowsPath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/i.test(value) && win32.isAbsolute(value);
}
function canonicalPagePath(value: string): string {
  return win32.normalize(value).replace(/[\\]+$/, "").toLowerCase();
}
function parsePageCommand(command: string, script: string): PageCommand | null {
  // A whole-command grammar: no unquoted metacharacters, extra flags or trailing commands.
  const match = /^[ \t]*(?:python(?:\.exe)?|py)(?:[ \t]+-I)?(?:[ \t]+-X[ \t]+utf8)?[ \t]+"([^"\r\n]+)"[ \t]+(kiem|so)[ \t]+"([^"\r\n]+)"[ \t]+--ra[ \t]+"([^"\r\n]+)"[ \t]*$/i.exec(command);
  if (!match || match[0].length !== command.length) return null;
  // Double-quoted PowerShell paths must be literal, not interpolated or escaped.
  if ([match[1], match[3], match[4]].some(value => /[$`]/.test(value))) return null;
  if (!absoluteWindowsPath(match[1]) || !absoluteWindowsPath(match[3]) || canonicalPagePath(match[1]) !== canonicalPagePath(script)) return null;
  return { mode: match[2].toLowerCase() as PageMode, target: canonicalPagePath(match[3]) };
}
export function enforceReceiptPageGate(
  script: string | null | undefined,
  files: readonly { path: string; mtimeMs: number }[],
  checks: readonly (ReceiptCheck & { evidence: ReceiptEvidence })[],
  audit: ReadonlyMap<number, PageAudit>,
): void {
  if (!script || !absoluteWindowsPath(script)) return;
  const missing: string[] = [];
  for (const file of files) {
    if (!/\.doc[xm]$/i.test(file.path)) continue;
    const target = canonicalPagePath(file.path);
    for (const mode of ["kiem", "so"] as const) {
      const marker = mode === "kiem" ? "KIEM_TRANG" : "KIEM_TRANG_SO";
      let covered = false, stale = false;
      for (let i = 0; i < checks.length; i++) {
        const check = checks[i], actual = audit.get(i);
        if (!actual || check.evidence.source !== "harness" || check.evidence.exit_code !== 0 ||
            check.expect_exit !== 0 || check.evidence.timed_out || !check.evidence.passed) continue;
        const declared = parsePageCommand(check.cmd, script);
        const parsed = parsePageCommand(actual.command, script);
        if (!declared || !parsed || declared.mode !== parsed.mode || declared.target !== parsed.target || parsed.mode !== mode) continue;
        if (target !== parsed.target && !target.startsWith(parsed.target + "\\")) continue;
        if (!new RegExp("^" + marker + ": DAT\\s*$", "m").test(actual.output)) continue;
        const checkedAt = Date.parse(String(actual.startedAt ?? actual.completedAt));
        if (!Number.isFinite(checkedAt)) continue;
        if (file.mtimeMs > checkedAt) { stale = true; continue; }
        covered = true;
        break;
      }
      if (!covered) missing.push(file.path + ": thieu " + marker + (stale ? " (sua sau khi kiem)" : "") +
        '; chay: python "' + script + '" ' + mode + ' "' + file.path + '" --ra "' + win32.join(win32.dirname(file.path), "_nghiemthu") + '"');
    }
  }
  if (missing.length) throw new Error("RECEIPT_PAGE_CHECK_REQUIRED: " + missing.join("\n"));
}
