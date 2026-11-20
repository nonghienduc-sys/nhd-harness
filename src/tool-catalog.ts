/** Optional per-client lightweight MCP tools/list catalogue. Never changes server-side validation. */
export type ToolCatalogSettings = {
  mode?: "full" | "catalog";
  clients?: string[];
  coreTools?: string[];
};

export const DEFAULT_TOOL_CATALOG_CORE_TOOLS = [
  "fs_read", "fs_list", "fs_stat", "fs_search",
  "fs_preview_write", "fs_apply_write", "doc_from_template", "doc_format_check",
  "terminal_preview", "terminal_execute", "terminal_session", "terminal_session_preview",
  "terminal_session_execute", "task_run", "task_run_step", "receipt_write",
  "workstation_plan", "office_read", "office_preview_edit", "office_apply_edit",
  "pdf_document", "tool_describe", "context_bootstrap", "context_recall",
  "tool_governor",
] as const;

const DESCRIBE_HINT = "Gọi tool_describe để xem tham số.";

export function toolCatalogMode(settings?: ToolCatalogSettings, clientName?: string | null): "full" | "catalog" {
  if (settings?.mode === "catalog") return "catalog";
  if (clientName && Array.isArray(settings?.clients) &&
      settings.clients.some((match) => typeof match === "string" && match.length > 0 && clientName.includes(match))) return "catalog";
  return "full";
}

export function toolCatalogCore(settings?: ToolCatalogSettings): Set<string> {
  const configured = Array.isArray(settings?.coreTools) ? settings.coreTools : [...DEFAULT_TOOL_CATALOG_CORE_TOOLS];
  // Always describe its own parameter schema; never advertise more than 25 core tools.
  return new Set([...configured.filter((x): x is string => typeof x === "string" && !!x && x !== "tool_describe").slice(0, 24), "tool_describe"]);
}

export function catalogueTool<T extends { name: string; description?: string; inputSchema?: unknown }>(tool: T, core: ReadonlySet<string>): T {
  if (core.has(tool.name)) return tool;
  const raw = String(tool.description ?? "").replace(/\s+/g, " ").trim();
  const room = Math.min(68, 160 - DESCRIBE_HINT.length - 1);
  let prefix = raw.slice(0, room).trimEnd();
  if (raw.length > room && prefix.includes(" ")) prefix = prefix.slice(0, prefix.lastIndexOf(" ")).trimEnd();
  return { ...tool, description: prefix ? prefix + " " + DESCRIBE_HINT : DESCRIBE_HINT,
    inputSchema: { type: "object" } };
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)));
    previous = next;
  }
  return previous[b.length];
}

export function suggestToolNames(name: string, names: readonly string[]): string[] {
  return [...names].sort((a, b) => editDistance(name, a) - editDistance(name, b) || a.localeCompare(b)).slice(0, 3);
}
