import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_PATTERN = /(password|passwd|token|secret|api[_-]?key|authorization)(\s*[=:]\s*)([^\s,;]+)/gi;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqualHash(raw: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(raw), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "$1$2[REDACTED]");
}

export const REDACTION_MARKER = "[REDACTED]";

export function countRedactionMarkers(value: string | null | undefined): number {
  if (!value) return 0;
  let count = 0;
  for (let at = value.indexOf(REDACTION_MARKER); at !== -1; at = value.indexOf(REDACTION_MARKER, at + REDACTION_MARKER.length)) count++;
  return count;
}

/** v0.24.14: redact and report whether anything was masked, so callers never mistake masked text for source. */
export function redactWithFlag(value: string): { text: string; redacted: boolean; redactedCount: number } {
  const text = redact(value);
  const redactedCount = Math.max(0, countRedactionMarkers(text) - countRedactionMarkers(value));
  return { text, redacted: redactedCount > 0, redactedCount };
}

/**
 * v0.24.14: refuse writes that introduce "[REDACTED]" markers absent from the original.
 * Such markers almost always come from copying a redacted fs_read result back into source
 * (the 2026-11-12 electron/main.cjs outage). Fail closed; the caller must use the real value.
 */
export function assertNoIntroducedRedaction(newContent: string, original: string | null | undefined, where: string): void {
  const added = countRedactionMarkers(newContent) - countRedactionMarkers(original);
  if (added > 0) {
    throw new Error(`REDACTION_MARKER_WRITE_BLOCKED: ${where} would write ${added} '${REDACTION_MARKER}' marker(s) that the original does not contain. This text was probably copied from a redacted read result; rewrite those values from the real source instead of the placeholder.`);
  }
}

export function nowIso(): string { return new Date().toISOString(); }

