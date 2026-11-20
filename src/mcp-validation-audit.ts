/**
 * SDK Zod validation happens before a tool handler. Extract path + code only:
 * never persist supplied argument values or SDK text (which can contain them).
 */
export function validationIssuesFromOutput(output: any): string[] | null {
  if (!output?.isError) return null;
  const message = (output.content ?? []).filter((item: any) => item?.type === "text")
    .map((item: any) => String(item.text ?? "")).find((line: string) => line.includes("Input validation error:"));
  if (!message) return null;
  const raw = message.slice(message.indexOf("Input validation error:") + "Input validation error:".length).trim();
  try {
    const parsed = JSON.parse(raw);
    const errors = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.issues) ? parsed.issues : [];
    const issues = errors.map((item: any) => {
      const path = Array.isArray(item.path) ? item.path.map((part: unknown) => String(part)).join(".") : "";
      const code = typeof item.code === "string" && /^[\w-]{1,80}$/.test(item.code) ? item.code : "invalid";
      return (path || "$") + ":" + code;
    });
    if (issues.length) return issues.slice(0, 100);
  } catch { /* An SDK error's textual formatting may vary between versions. */ }
  // Recent MCP SDK versions render a human-readable Zod issue rather than JSON.
  // Only retain a syntactically valid field path and a known error code.
  const inferred = raw.split(/;\s*(?=(?:Invalid|Too|Unrecognized|Expected)\b)/i).map((part: string) => {
    const match = part.match(/\bat\s+([A-Za-z_][A-Za-z0-9_.\[\]-]{0,127})\s*$/);
    const path = match ? match[1] : "$";
    const code = /expected\s+\w+[^\n]*received\s+\w+/i.test(part) ? "invalid_type"
      : /too small|must be greater|at least/i.test(part) ? "too_small"
      : /too big|must be less|at most/i.test(part) ? "too_big"
      : /unrecognized key/i.test(part) ? "unrecognized_keys"
      : /invalid (?:option|value|enum)/i.test(part) ? "invalid_value"
      : "invalid_schema";
    return path + ":" + code;
  });
  return inferred.slice(0, 100);
}
