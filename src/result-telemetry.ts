import { randomBytes } from "node:crypto";

export type ResultSizeWarning = "normal" | "large" | "very_large";
export type VerificationState = "verified" | "ambiguous" | "failed" | null;

export type ResultTelemetryEntry = {
  toolName: string;
  at: string;
  elapsedMs: number;
  rawChars: number;
  resultChars: number;
  estimatedTokens: number;
  savedChars: number;
  savedEstimatedTokens: number;
  compacted: boolean;
  artifactId: string | null;
  sizeCapped: boolean;
  warning: ResultSizeWarning;
  truncated: boolean;
  paginated: boolean;
  isError: boolean;
  verification: VerificationState;
  traceId: string;
  spanId: string;
  parentTaskRunId: string | null;
  spanKind: "TOOL";
};

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_COUNT_CAP = 5_000_000;
const LARGE_RESULT_CHARS = 8_000;
const VERY_LARGE_RESULT_CHARS = 16_000;

function jsonStringLength(value: string): number {
  let length = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) length += 2;
    else if (code < 0x20) length += 6;
    else length += 1;
  }
  return length;
}

function boundedJsonLength(value: unknown, cap: number): { chars: number; capped: boolean } {
  const seen = new WeakSet<object>();
  let capped = false;
  const add = (current: number, delta: number) => {
    const next = current + delta;
    if (next >= cap) {
      capped = true;
      return cap;
    }
    return next;
  };
  const count = (input: unknown): number => {
    if (capped) return 0;
    if (input === null) return 4;
    if (typeof input === "string") return Math.min(jsonStringLength(input), cap);
    if (typeof input === "number") return Number.isFinite(input) ? String(input).length : 4;
    if (typeof input === "boolean") return input ? 4 : 5;
    if (typeof input === "bigint") return jsonStringLength(String(input));
    if (typeof input === "undefined" || typeof input === "function" || typeof input === "symbol") return 0;
    if (Array.isArray(input)) {
      if (seen.has(input)) return jsonStringLength("[Circular]");
      seen.add(input);
      let total = 2;
      for (let index = 0; index < input.length && !capped; index += 1) {
        if (index) total = add(total, 1);
        const item = input[index];
        total = add(total, item === undefined || typeof item === "function" || typeof item === "symbol" ? 4 : count(item));
      }
      seen.delete(input);
      return total;
    }
    const object = input as Record<string, unknown>;
    if (seen.has(object)) return jsonStringLength("[Circular]");
    seen.add(object);
    let total = 2;
    let emitted = 0;
    for (const key of Object.keys(object)) {
      const item = object[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      if (emitted) total = add(total, 1);
      total = add(total, jsonStringLength(key));
      total = add(total, 1);
      total = add(total, count(item));
      emitted += 1;
      if (capped) break;
    }
    seen.delete(object);
    return total;
  };
  return { chars: Math.min(count(value), cap), capped };
}

function resultFlags(value: unknown): { truncated: boolean; paginated: boolean; isError: boolean; verification: VerificationState } {
  let truncated = false;
  let paginated = false;
  let isError = false;
  let verification: VerificationState = null;
  const seen = new WeakSet<object>();
  let visited = 0;
  const considerVerification = (key: string, item: unknown) => {
    if (typeof item !== "string") return;
    const normalizedKey = key.toLowerCase().replace(/[_-]/g, "");
    if (!["verification", "verificationstate", "outcome", "state"].includes(normalizedKey)) return;
    const normalizedValue = item.trim().toLowerCase();
    if (normalizedValue === "verified" || normalizedValue === "success") verification = verification ?? "verified";
    else if (normalizedValue === "ambiguous" || normalizedValue === "uncertain") verification = "ambiguous";
    else if (normalizedValue === "failed" || normalizedValue === "failure") verification = "failed";
  };
  const visit = (input: unknown, depth: number) => {
    if (depth > 8 || visited >= 2048 || input == null || typeof input !== "object") return;
    const object = input as Record<string, unknown>;
    if (seen.has(object)) return;
    seen.add(object);
    visited += 1;
    for (const [key, item] of Object.entries(object)) {
      const normalized = key.toLowerCase().replace(/[_-]/g, "");
      if ((normalized === "truncated" || normalized === "istruncated") && item === true) truncated = true;
      if (["nextcursor", "nextread", "nextpage", "continuationtoken"].includes(normalized) && item != null && item !== "") paginated = true;
      if (["hasmore", "moreavailable"].includes(normalized) && item === true) paginated = true;
      if (normalized === "iserror" && item === true) isError = true;
      considerVerification(key, item);
      if (item && typeof item === "object") visit(item, depth + 1);
      if (truncated && paginated && isError && verification === "failed") break;
    }
  };
  visit(value, 0);
  return { truncated, paginated, isError, verification };
}

function taskRunIdFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  const value = row.task_run_id ?? row.taskRunId ?? row.run_id ?? row.runId;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^task-[A-Za-z0-9_-]{6,200}$/.test(normalized) ? normalized : null;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

export class ResultTelemetryService {
  private readonly entries: ResultTelemetryEntry[] = [];
  private readonly maxEntries: number;
  private readonly countCap: number;

  private totalCallsCount = 0;
  private totalCompactedCount = 0;
  private totalRawCharsCount = 0;
  private totalReturnedCharsCount = 0;

  constructor(options: { maxEntries?: number; countCap?: number } = {}) {
    this.maxEntries = Math.max(16, Math.min(Number(options.maxEntries ?? DEFAULT_MAX_ENTRIES), 4096));
    this.countCap = Math.max(VERY_LARGE_RESULT_CHARS, Math.min(Number(options.countCap ?? DEFAULT_COUNT_CAP), 50_000_000));
  }

  observe(
    toolName: string,
    result: unknown,
    elapsedMs: number,
    input?: unknown,
    gatewayMeta?: { rawChars?: number; compacted?: boolean; artifactId?: string | null },
  ): ResultTelemetryEntry {
    const measured = boundedJsonLength(result, this.countCap);
    const flags = resultFlags(result);
    const rawChars = typeof gatewayMeta?.rawChars === "number" && Number.isFinite(gatewayMeta.rawChars)
      ? Math.max(measured.chars, Math.trunc(gatewayMeta.rawChars))
      : measured.chars;
    const compacted = Boolean(gatewayMeta?.compacted);
    const savedChars = Math.max(0, rawChars - measured.chars);
    const savedEstimatedTokens = Math.ceil(savedChars / 4);
    const warning: ResultSizeWarning = measured.chars > VERY_LARGE_RESULT_CHARS ? "very_large" : measured.chars > LARGE_RESULT_CHARS ? "large" : "normal";
    const entry: ResultTelemetryEntry = {
      toolName: String(toolName).slice(0, 200),
      at: new Date().toISOString(),
      elapsedMs: Math.max(0, Number(elapsedMs.toFixed(3))),
      rawChars,
      resultChars: measured.chars,
      estimatedTokens: Math.ceil(measured.chars / 4),
      savedChars,
      savedEstimatedTokens,
      compacted,
      artifactId: gatewayMeta?.artifactId ?? null,
      sizeCapped: measured.capped,
      warning,
      truncated: flags.truncated,
      paginated: flags.paginated,
      isError: flags.isError,
      verification: flags.verification,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      parentTaskRunId: taskRunIdFromInput(input),
      spanKind: "TOOL",
    };
    this.totalCallsCount += 1;
    if (compacted) this.totalCompactedCount += 1;
    this.totalRawCharsCount += rawChars;
    this.totalReturnedCharsCount += measured.chars;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return { ...entry };
  }

  recordGatewayDecision(
    spanId: string | undefined,
    decision: { compacted: boolean; originalChars: number; compactedChars: number; artifactSha256: string | null },
  ) {
    if (!decision) return;
    const entry = spanId ? this.entries.find((item) => item.spanId === spanId) : this.entries.at(-1);
    if (!entry) return;
    const prevRaw = entry.rawChars;
    const prevReturned = entry.resultChars;
    const prevCompacted = entry.compacted;
    const rawChars = Math.max(entry.resultChars, Math.trunc(decision.originalChars || entry.resultChars));
    const returnedChars = decision.compacted ? Math.trunc(decision.compactedChars) : entry.resultChars;
    const savedChars = Math.max(0, rawChars - returnedChars);
    entry.rawChars = rawChars;
    entry.compacted = Boolean(decision.compacted);
    entry.savedChars = savedChars;
    entry.savedEstimatedTokens = Math.ceil(savedChars / 4);
    entry.artifactId = decision.artifactSha256 ?? null;
    if (decision.compacted && !prevCompacted) this.totalCompactedCount += 1;
    this.totalRawCharsCount += rawChars - prevRaw;
    this.totalReturnedCharsCount += returnedChars - prevReturned;
  }

  openInferenceSpans(limit = 30) {
    return this.entries.slice(-Math.max(1, Math.min(limit, 100))).map((entry) => {
      const endMs = Date.parse(entry.at);
      const startMs = Number.isFinite(endMs) ? endMs - entry.elapsedMs : endMs;
      return {
        trace_id: entry.traceId,
        span_id: entry.spanId,
        parent_task_run_id: entry.parentTaskRunId,
        name: entry.toolName,
        span_kind: "TOOL",
        start_time: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
        end_time: entry.at,
        status: entry.isError || entry.verification === "failed" ? "ERROR" : entry.verification === "ambiguous" ? "UNSET" : "OK",
        attributes: {
          "openinference.span.kind": "TOOL",
          "tool.name": entry.toolName,
          "nhd.result.raw_chars": entry.rawChars,
          "nhd.result.chars": entry.resultChars,
          "nhd.result.estimated_tokens": entry.estimatedTokens,
          "nhd.result.compacted": entry.compacted,
          "nhd.result.saved_chars": entry.savedChars,
          "nhd.result.saved_estimated_tokens": entry.savedEstimatedTokens,
          "nhd.result.truncated": entry.truncated,
          "nhd.result.paginated": entry.paginated,
          "nhd.result.warning": entry.warning,
          "nhd.verification.state": entry.verification,
        },
      };
    });
  }

  status() {
    const recent = this.entries.map((entry) => ({ ...entry }));
    const sizes = recent.map((entry) => entry.resultChars);
    const elapsed = recent.map((entry) => entry.elapsedMs);
    const topPayloads = [...recent].sort((a, b) => b.resultChars - a.resultChars || b.elapsedMs - a.elapsedMs).slice(0, 10);
    const errors = recent.filter((entry) => entry.isError || entry.verification === "failed").length;
    const ambiguous = recent.filter((entry) => entry.verification === "ambiguous").length;
    const totalSavedChars = Math.max(0, this.totalRawCharsCount - this.totalReturnedCharsCount);
    const compactionSavingsRatio = this.totalRawCharsCount > 0
      ? Number(Math.max(0, 1 - this.totalReturnedCharsCount / this.totalRawCharsCount).toFixed(6))
      : 0;
    return {
      available: true,
      mode: "metadata-only-openinference-compatible-telemetry-v2",
      storesRawResults: false,
      storesRawInputs: false,
      modifiesResults: false,
      remoteExporterEnabled: false,
      traceSemantics: { standard: "OpenInference-compatible", spanKind: "TOOL", traceIds: "W3C-sized random IDs", taskCorrelation: "task_run_id metadata only" },
      maxEntries: this.maxEntries,
      countCapChars: this.countCap,
      warningThresholds: { largeChars: LARGE_RESULT_CHARS, veryLargeChars: VERY_LARGE_RESULT_CHARS },
      budgetPolicy: { mode: "advisory-only", automaticTruncation: false, safetyCriticalTruncation: false },
      calls: recent.length,
      totalCalls: this.totalCallsCount,
      p50ResultChars: percentile(sizes, 0.5),
      p95ResultChars: percentile(sizes, 0.95),
      p50ElapsedMs: percentile(elapsed, 0.5),
      p95ElapsedMs: percentile(elapsed, 0.95),
      largeResults: recent.filter((entry) => entry.warning === "large").length,
      veryLargeResults: recent.filter((entry) => entry.warning === "very_large").length,
      truncatedResults: recent.filter((entry) => entry.truncated).length,
      paginatedResults: recent.filter((entry) => entry.paginated).length,
      cappedMeasurements: recent.filter((entry) => entry.sizeCapped).length,
      compactedResults: recent.filter((entry) => entry.compacted).length,
      gatewayCompaction: {
        totalCompactedCalls: this.totalCompactedCount,
        totalRawChars: this.totalRawCharsCount,
        totalReturnedChars: this.totalReturnedCharsCount,
        totalSavedChars,
        totalSavedEstimatedTokens: Math.ceil(totalSavedChars / 4),
        savingsRatio: compactionSavingsRatio,
      },
      evaluation: {
        errors,
        ambiguous,
        verified: recent.filter((entry) => entry.verification === "verified").length,
        errorRate: recent.length ? errors / recent.length : 0,
        ambiguousRate: recent.length ? ambiguous / recent.length : 0,
      },
      topPayloads,
      recent: recent.slice(-30).reverse(),
      recentSpans: this.openInferenceSpans(30).reverse(),
    };
  }
}
