import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, win32 } from "node:path";
import { enforceReceiptPageGate, verifyReceiptChecks, type ReceiptAuditRow } from "./receipt-checks.js";

export const LEDGER_COLUMNS = [
  "ngay", "phieu", "khung_chat", "loai_viec", "so_van_ban", "gui_luc", "tra_luc",
  "worked_phut", "ket_qua", "ly_do_ket", "vong_sua", "nghiem_thu",
  "loi_nguoi_dung_bat", "ghi_chu"
] as const;

type SealState = { path: string; sha256: string; mtimeMs: number; sealedAt: number };
const sealsByTask = new Map<string, SealState[]>();
const credentialKey = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential)/i;
const credentialText = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i,
  new RegExp("\\b" + "s" + "k" + "-[A-Za-z0-9_-]{16,}\\b"),
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /https?:\/\/[^/\s:@]+:[^@\s]+@/i
];

export function assertReceiptSafe(value: unknown, location = "receipt"): void {
  if (typeof value === "string") {
    if (credentialText.some((pattern) => pattern.test(value))) throw new Error("RECEIPT_SECRET_BLOCKED: " + location);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReceiptSafe(entry, location + "[" + index + "]"));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (credentialKey.test(key)) throw new Error("RECEIPT_SECRET_BLOCKED: " + location + "." + key);
      assertReceiptSafe(entry, location + "." + key);
    }
  }
}

export function hashReceiptFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Only trusted configuration may select allowed source roots (not receipt metadata).
const DEFAULT_SOURCE_COPY_ROOT = "D:\\NHD Nghiem Thu\\kho_xa\\tep";

function normalizeSourceCopyPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !win32.isAbsolute(value) || value.includes("\0")) return undefined;
  // Require a drive-qualified or ordinary UNC path. Reject drive-relative,
  // current-drive-rooted, device-namespace paths and alternate data streams.
  if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/? .][^\\/?]*[\\/][^\\/?]+)/i.test(value)) return undefined;
  if (/[\\/]{2}[?.][\\/]/.test(value) || value.slice(/^[a-z]:/i.test(value) ? 2 : 0).includes(":")) return undefined;
  return win32.normalize(value);
}

function isInsideSourceRoot(path: string, root: string): boolean {
  const canonicalRoot = win32.normalize(root).replace(/\\+$/, "").toLowerCase();
  const canonicalPath = win32.normalize(path).toLowerCase();
  return canonicalPath.startsWith(canonicalRoot + "\\") && canonicalPath !== canonicalRoot + "\\";
}

function verifySourceCopy(source: unknown, artifactHash: string, roots: readonly string[]):
  { path: string; matches: boolean } | undefined {
  const path = normalizeSourceCopyPath(source);
  if (!path) return undefined;
  // First check lexical containment; then check real paths to prevent a
  // symlink/junction within an allowed root from resolving outside it.
  for (const rawRoot of roots) {
    const root = normalizeSourceCopyPath(rawRoot);
    if (!root || !isInsideSourceRoot(path, root)) continue;
    try {
      if (!statSync(root).isDirectory()) continue;
      const realRoot = realpathSync.native(root), realSource = realpathSync.native(path);
      if (!isInsideSourceRoot(realSource, realRoot) || !statSync(realSource).isFile()) continue;
      return { path, matches: hashReceiptFile(realSource) === artifactHash };
    } catch { /* Missing/inaccessible source cannot establish an exemption. */ }
  }
  return undefined;
}

function atomicWrite(path: string, data: string) {
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    writeFileSync(temporary, data, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[,\r\n"]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current); current = "";
    } else current += char;
  }
  values.push(current);
  return values;
}

export function updateTimeLedger(path: string, taskName: string, startedAt: string, sealedAt: string): void {
  if (!taskName.trim()) throw new Error("Receipt task must be nonempty to log time.");
  const started = Date.parse(startedAt), sealed = Date.parse(sealedAt);
  if (!Number.isFinite(started) || !Number.isFinite(sealed) || sealed < started)
    throw new Error("Invalid task start/seal timestamps.");
  const values: Record<string, string> = {
    ngay: sealedAt.slice(0, 10), phieu: taskName, gui_luc: startedAt, tra_luc: sealedAt,
    worked_phut: ((sealed - started) / 60000).toFixed(2), ket_qua: "XONG"
  };
  const exists = existsSync(path);
  const raw = exists ? readFileSync(path, "utf8") : "";
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = raw.slice(bom.length);
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body ? body.split(/(\r\n|\n)/) : [];
  // Keep every untouched line byte-for-byte, including its original line ending.
  const entries: Array<{ text: string; eol: string }> = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (i === lines.length - 1 && lines[i] === "") break;
    entries.push({ text: lines[i] ?? "", eol: lines[i + 1] ?? "" });
  }
  if (!entries.length) entries.push({ text: LEDGER_COLUMNS.join(","), eol });
  const header = parseCsvLine(entries[0].text);
  if (LEDGER_COLUMNS.some((col, index) => header[index] !== col)) throw new Error("Time ledger has unexpected columns.");
  const taskIndex = header.indexOf("phieu"), returnIndex = header.indexOf("tra_luc");
  let updated = false;
  for (let i = 1; i < entries.length; i++) {
    if (!entries[i].text) continue;
    const row = parseCsvLine(entries[i].text);
    if (row[taskIndex] !== taskName || String(row[returnIndex] ?? "").trim()) continue;
    for (const [col, val] of Object.entries(values)) row[header.indexOf(col)] = val;
    entries[i].text = row.map(csvCell).join(",");
    updated = true;
    break;
  }
  if (!updated) {
    const row = LEDGER_COLUMNS.map((col) => csvCell(values[col] ?? "")).join(",");
    if (entries.length && !entries[entries.length - 1].eol) entries[entries.length - 1].eol = eol;
    entries.push({ text: row, eol });
  }
  atomicWrite(path, bom + entries.map((item) => item.text + item.eol).join(""));
}

export type ReceiptWriteOptions = {
  path: string;
  receipt: Record<string, unknown>;
  taskRunId?: string | null;
  taskStartedAt?: string | null;
  ledgerPath?: string | null;
  pageGateScript?: string | null;
  sourceCopyRoots?: readonly string[];
  now?: () => Date;
  auditRows?: readonly ReceiptAuditRow[];
};
export function receiptWrite(options: ReceiptWriteOptions) {
  const outputPath = resolve(options.path);
  if (!isAbsolute(options.path)) throw new Error("Receipt path must be absolute.");
  if (!options.receipt || typeof options.receipt !== "object" || Array.isArray(options.receipt))
    throw new Error("Receipt must be an object.");
  assertReceiptSafe(options.receipt);
  const files = options.receipt.files;
  if (!Array.isArray(files)) throw new Error("Receipt files must be an array.");
  const blocked = ["ket", "failed", "blocked"].includes(String(options.receipt.status ?? "").toLowerCase())
    || String(options.receipt.trang_thai ?? "").toUpperCase() === "KET";
  const configuredRoots = process.env.NHD_NGUON_GOC_ROOTS;
  const sourceCopyRoots = options.sourceCopyRoots ??
    (configuredRoots === undefined ? [DEFAULT_SOURCE_COPY_ROOT] : configuredRoots.split(";").map(root => root.trim()).filter(Boolean));
  const verifiedSourceCopies = new Set<string>();
  const seen = new Set<string>();
  const artifacts = files.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid receipt files item.");
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || !isAbsolute(item.path)) throw new Error("Receipt file path must be absolute.");
    const fullPath = resolve(item.path), canonical = fullPath.toLowerCase();
    if (seen.has(canonical)) throw new Error("Duplicate receipt file: " + fullPath);
    seen.add(canonical);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) throw new Error("RECEIPT_FILE_MISSING: " + fullPath);
    const sha256 = hashReceiptFile(fullPath);
    if (Object.prototype.hasOwnProperty.call(item, "nguon_goc")) {
      const source = verifySourceCopy(item.nguon_goc, sha256, sourceCopyRoots);
      if (!source && !blocked) {
        const code = /\.doc[xm]$/i.test(fullPath) ? "RECEIPT_PAGE_CHECK_REQUIRED" : "RECEIPT_SOURCE_COPY_INVALID";
        throw new Error(code + ": " + fullPath + ": invalid nguon_goc (not a regular source file inside an allowed root)");
      }
      if (source) {
        if (source.matches) verifiedSourceCopies.add(fullPath);
        return { ...item, path: fullPath, nguon_goc: source.path, sha256 };
      }
    }
    return { ...item, path: fullPath, sha256 };
  });
  const now = options.now?.() ?? new Date();
  const sealedAt = now.toISOString();
  const taskRunId = options.taskRunId?.trim() || null;
  const pageAudit = new Map();
  const { checks, summary } = verifyReceiptChecks(options.receipt.checks, options.auditRows ?? [], taskRunId, now, pageAudit);
  const failed = checks.flatMap((check, index) => check.evidence.passed ? [] :
    ["#" + (index + 1) + " " + check.cmd + ": " + (check.evidence.source === "missing" ? "missing harness evidence" :
      "exit=" + check.evidence.exit_code + ", timeout=" + check.evidence.timed_out + ", output_tail=" + (check.evidence.output_tail ?? ""))]);
  if (!blocked && options.pageGateScript && isAbsolute(options.pageGateScript)) {
    enforceReceiptPageGate(options.pageGateScript, artifacts.filter(item => !verifiedSourceCopies.has(item.path)).map(item => ({
      path: item.path, mtimeMs: statSync(item.path).mtimeMs
    })), checks, pageAudit);
  }
  if (failed.length && !blocked) throw new Error("RECEIPT_CHECKS_FAILED: " + failed.join("; "));
  const sealed: Record<string, unknown> = { ...options.receipt, files: artifacts, checks,
    checks_verified_by: "harness", checks_summary: summary, sealed_at: sealedAt };
  if (taskRunId) sealed.task_run_id = taskRunId;
  assertReceiptSafe(sealed);
  // Preflight the ledger before sealing; no receipt is produced if the configured path is invalid.
  const ledger = options.ledgerPath?.trim();
  if (ledger && !isAbsolute(ledger)) throw new Error("Time ledger path must be absolute.");
  const json = JSON.stringify(sealed, null, 2) + "\n";
  atomicWrite(outputPath, json);
  if (taskRunId) {
    const previous = sealsByTask.get(taskRunId) ?? [];
    const latest = artifacts.map((entry) => {
      const filePath = resolve(String(entry.path));
      return { path: filePath, sha256: String(entry.sha256), mtimeMs: statSync(filePath).mtimeMs, sealedAt: Date.parse(sealedAt) };
    });
    sealsByTask.set(taskRunId, [...previous, ...latest]);
  }
  let ledgerStatus = "disabled";
  if (ledger) {
    updateTimeLedger(ledger, String(sealed.task ?? ""), options.taskStartedAt || sealedAt, sealedAt);
    ledgerStatus = "updated";
  }
  return { path: outputPath, sealed_at: sealedAt, task_run_id: taskRunId, files: artifacts.length, ledger: ledgerStatus };
}
export function receiptStaleWarnings(taskRunId?: string | null): string[] {
  if (!taskRunId) return [];
  const records = sealsByTask.get(taskRunId) ?? [];
  const changed = new Set<string>();
  for (const record of records) {
    try {
      const stat = statSync(record.path);
      if (stat.mtimeMs !== record.mtimeMs || hashReceiptFile(record.path) !== record.sha256)
        changed.add("RECEIPT_STALE: " + record.path);
    } catch { changed.add("RECEIPT_STALE: " + record.path); }
  }
  return [...changed].sort();
}
