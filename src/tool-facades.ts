import { z } from "zod";

/**
 * v0.24.15 tool facades.
 *
 * Merges same-permission tool families into one listed tool with an `op` selector,
 * shrinking the tools/list payload. Rules:
 * - Only tools with identical safety annotations are merged (read-only, preview and
 *   apply stay apart), so client-side confirmation behaviour is unchanged.
 * - Every old tool name stays callable for at least two releases; it is only hidden
 *   from tools/list (deprecated, removal planned no earlier than v0.24.18).
 * - When the facade reuses an old tool name, that tool is the default `op`, so
 *   existing calls without `op` behave exactly as before.
 * - Dispatch calls the member's own wrapped handler, so governor, telemetry,
 *   result gateway, task context and per-tool policy still apply under the member name.
 * Disable with NHD_TOOL_FACADES=0.
 */
export type ToolFacadeSpec = { name: string; summary: string; defaultOp?: string; members: Record<string, string> };

export const TOOL_FACADES: readonly ToolFacadeSpec[] = Object.freeze(<ToolFacadeSpec[]>[
  { name: "workstation_health", summary: "Workstation health.", defaultOp: "deep", members: { deep: "workstation_health", fast: "workstation_health_fast" } },
  { name: "local_ai_router", summary: "Deterministic local AI router (no model invocation).", members: { status: "local_ai_status", route: "local_ai_route", dispatch: "local_ai_dispatch", verify: "local_ai_verify" } },
  { name: "skills_registry", summary: "Skill registry (read-only).", members: { list: "skills_list", search: "skills_search", get: "skills_get", activate: "skills_activate", read_resource: "skills_read_resource", validate: "skills_validate" } },
  { name: "self_evolution_inspect", summary: "Self-evolution read-only views.", members: { status: "self_evolution_status", analyze: "self_evolution_analyze", evaluate: "self_evolution_evaluate" } },
  { name: "self_evolution_feedback", summary: "Self-evolution feedback and proposals (writes evolution metadata only).", members: { record_feedback: "self_evolution_record_feedback", propose: "self_evolution_propose" } },
  { name: "background_turbo", summary: "Background turbo lane (read-only).", members: { status: "background_turbo_status", micro_batch: "background_micro_batch", dag: "background_dag", artifact_handle: "background_artifact_handle" } },
  { name: "execution_info", summary: "Execution lane status and routing (read-only).", members: { lanes_status: "execution_lanes_status", route: "execution_route" } },
  { name: "execution_control", summary: "Execution scheduler, locks and lane handoffs.", members: { scheduler: "execution_scheduler", lock: "execution_lock", handoff: "execution_handoff" } },
  { name: "isolated_agent_control", summary: "Start or stop the isolated Windows Sandbox agent.", members: { start: "isolated_agent_start", stop: "isolated_agent_stop" } },
  { name: "isolated_desktop_read", summary: "Isolated agent status and isolated desktop reads.", members: { agent_status: "isolated_agent_status", windows: "isolated_desktop_windows", inspect: "isolated_desktop_inspect", screenshot: "isolated_desktop_screenshot" } },
  { name: "isolated_browser_read", summary: "Isolated browser reads.", members: { status: "isolated_browser_status", snapshot: "isolated_browser_snapshot", inspect: "isolated_browser_inspect", screenshot: "isolated_browser_screenshot" } },
  { name: "isolated_browser_act", summary: "Isolated browser actions.", members: { navigate: "isolated_browser_navigate", click: "isolated_browser_click", fill: "isolated_browser_fill", press: "isolated_browser_press" } },
  { name: "project_rag_query", summary: "Project RAG evidence query and index status.", defaultOp: "query", members: { query: "project_rag_query", status: "project_rag_status" } },
  { name: "task_protocol_status", summary: "Task protocol status and agent cycle (read-only).", defaultOp: "status", members: { status: "task_protocol_status", agent_cycle: "task_agent_cycle" } },
  { name: "context_recall", summary: "Context recall and lookups (read-only).", defaultOp: "recall", members: { recall: "context_recall", find_project: "context_find_project", chat_history: "context_chat_history" } },
  { name: "context_checkpoint", summary: "Context memory records.", defaultOp: "checkpoint", members: { checkpoint: "context_checkpoint", chat_binding: "context_chat_binding", working_state: "context_working_state", daily_progress: "context_daily_progress" } },
  { name: "screen_capture", summary: "Screen sources and capture (every capture is audited; window titles may be sensitive).", defaultOp: "capture", members: { capture: "screen_capture", list: "screen_list", preview: "screen_preview_capture", apply: "screen_apply_capture" } },
  { name: "desktop_inspect", summary: "Host desktop reads.", defaultOp: "inspect", members: { inspect: "desktop_inspect", windows: "desktop_windows" } },
  { name: "video_understand", summary: "Video understanding.", defaultOp: "understand", members: { understand: "video_understand", inspect: "video_inspect", frame: "video_frame", context: "video_context" } },
  { name: "media_source_discover", summary: "Media source discovery and material planning.", defaultOp: "discover", members: { discover: "media_source_discover", plan: "media_material_plan" } },
  { name: "media_source_status", summary: "Media source status and rights review.", defaultOp: "status", members: { status: "media_source_status", rights_review: "media_material_rights_review" } },
  { name: "project_open", summary: "Project workspace (reads; mutations need preview + confirmation token; imported external sources stay untrusted evidence).", defaultOp: "open", members: { open: "project_open", status: "project_status", memory: "project_memory", decision: "project_decision", sources: "project_sources", snapshot: "project_snapshot" } },
  { name: "document_context", summary: "Structured document reads and edit sessions.", defaultOp: "context", members: { context: "document_context", index: "document_index", related: "document_related", edit_session: "document_edit_session", qa: "document_qa" } },
  { name: "outlook_search", summary: "Outlook (read-only).", defaultOp: "search", members: { search: "outlook_search", read: "outlook_read" } },
  { name: "office_admin_release_status", summary: "Admin release status and preview.", defaultOp: "status", members: { status: "office_admin_release_status", preview: "office_admin_release_preview" } },
  { name: "office_live_insert_at_cursor", summary: "Office Live block insertion (Direct Fast Lane: fingerprinted preview/apply, verified text+format, adaptive QA; use instead of Terminal/COM).", defaultOp: "insert_at_cursor", members: { insert_at_cursor: "office_live_insert_at_cursor", append: "office_live_append" } },
  { name: "browser_inspect", summary: "Dedicated browser reads and waits.", defaultOp: "inspect", members: { inspect: "browser_inspect", wait: "browser_wait", wait_for: "browser_wait_for", screenshot: "browser_screenshot" } },
  { name: "coc_coc_inspect", summary: "Coc Coc DOM reads and waits.", defaultOp: "inspect", members: { inspect: "coc_coc_inspect", tabs: "coc_coc_tabs", page: "coc_coc_page", snapshot: "coc_coc_snapshot", observe: "coc_coc_observe", wait_for: "coc_coc_wait_for", screenshot: "coc_coc_screenshot" } },
]);

export type CapturedTool = { definition: any; handler: (...args: any[]) => unknown };

export function toolFacadesEnabled(env: NodeJS.ProcessEnv = process.env) { return env.NHD_TOOL_FACADES !== "0"; }

/** Names whose own registration is replaced by the facade registered under the same name. */
export function facadeOwnedNames(specs: readonly ToolFacadeSpec[] = TOOL_FACADES) {
  return new Set(specs.filter((spec) => Object.values(spec.members).includes(spec.name)).map((spec) => spec.name));
}

/** Member names hidden from tools/list but still callable. */
export function facadeHiddenNames(specs: readonly ToolFacadeSpec[] = TOOL_FACADES) {
  const hidden = new Set<string>();
  for (const spec of specs) for (const member of Object.values(spec.members)) if (member !== spec.name) hidden.add(member);
  return hidden;
}

function schemaKey(schema: any): string {
  try { return JSON.stringify((z as any).toJSONSchema(schema)); } catch { return `ref:${Math.random()}`; }
}

function mergeAnnotations(list: Array<Record<string, unknown> | undefined>) {
  const all = list.map((a) => a ?? {});
  const every = (key: string) => all.every((a) => a[key] === true);
  const any = (key: string) => all.some((a) => a[key] === true);
  return { readOnlyHint: every("readOnlyHint"), destructiveHint: any("destructiveHint"), idempotentHint: every("idempotentHint"), openWorldHint: any("openWorldHint") };
}

export function annotationSignature(annotations: Record<string, unknown> | undefined) {
  const a = annotations ?? {};
  return `${a.readOnlyHint === true ? "R" : "-"}${a.destructiveHint === true ? "D" : "-"}${a.openWorldHint === true ? "O" : "-"}`;
}

const failure = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

/** v0.24.17: facade op lines keep whole leading sentences up to ~140 chars to cut tools/list bytes. */
export const FACADE_OP_DESCRIPTION_BUDGET = 140;
export function briefDescription(raw: unknown, budget = FACADE_OP_DESCRIPTION_BUDGET): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= budget) return text;
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  let out = sentences[0];
  for (const next of sentences.slice(1)) {
    if (out.length + 1 + next.length > budget) break;
    out += " " + next;
  }
  return out.length > budget + 60 ? out.slice(0, budget + 57).trimEnd() + "..." : out;
}

export function buildFacade(spec: ToolFacadeSpec, captured: Map<string, CapturedTool>) {
  const ops = Object.keys(spec.members).filter((op) => captured.has(spec.members[op]));
  if (ops.length < 2) return null;
  const members = ops.map((op) => ({ op, name: spec.members[op], ...captured.get(spec.members[op])! }));
  const signatures = new Set(members.map((m) => annotationSignature(m.definition?.annotations)));
  if (signatures.size > 1) throw new Error(`TOOL_FACADE_ANNOTATION_MISMATCH: ${spec.name} merges ${[...signatures].join(" / ")}`);
  const fields = new Map<string, any[]>();
  for (const member of members) {
    for (const [key, schema] of Object.entries((member.definition?.inputSchema ?? {}) as Record<string, any>)) {
      if (key === "op") throw new Error(`TOOL_FACADE_FIELD_CONFLICT: ${member.name} already defines op`);
      const list = fields.get(key) ?? [];
      if (!list.some((existing) => existing === schema || schemaKey(existing) === schemaKey(schema))) list.push(schema);
      fields.set(key, list);
    }
  }
  const defaultOp = spec.defaultOp && ops.includes(spec.defaultOp) ? spec.defaultOp : undefined;
  const opSchema = z.enum(ops as [string, ...string[]]);
  const shape: Record<string, any> = {
    op: (defaultOp ? opSchema.optional() : opSchema).describe(`Operation${defaultOp ? ` (default ${defaultOp})` : ""}. Fields not used by the chosen op are ignored.`),
  };
  for (const [key, list] of fields) {
    const base = list.length === 1 ? list[0] : z.union(list as [any, any, ...any[]]);
    shape[key] = typeof base.optional === "function" ? base.optional() : base;
  }
  const description = [
    `${spec.summary} Choose op:`,
    ...members.map((m) => `- op=${m.op}${m.name === spec.name ? "" : ` (was ${m.name})`}: ${briefDescription(m.definition?.description)}`),
  ].join("\n");
  const definition = { description, inputSchema: shape, annotations: mergeAnnotations(members.map((m) => m.definition?.annotations)) };
  const byOp = new Map(members.map((m) => [m.op, m]));
  const handler = async (input: Record<string, unknown> = {}, extra?: unknown) => {
    const op = typeof input.op === "string" ? input.op : defaultOp;
    const member = op ? byOp.get(op) : undefined;
    if (!member) return failure(`${spec.name}: op is required; choose one of ${ops.join(", ")}.`);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) if (key !== "op" && value !== undefined) rest[key] = value;
    const memberShape = member.definition?.inputSchema;
    if (memberShape === undefined) return member.handler(extra);
    const parsed = z.object(memberShape).safeParse(rest);
    if (!parsed.success) return failure(`${spec.name} op=${member.op}: invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
    return member.handler(parsed.data, extra);
  };
  return { name: spec.name, definition, handler, ops };
}

/** Wraps an McpServer's tools/list handler so hidden (deprecated) names are not advertised. */
export function hideToolsFromList(server: any, hidden: Set<string>) {
  const handlers: Map<string, (...args: any[]) => any> | undefined = server?.server?._requestHandlers;
  const original = handlers?.get("tools/list");
  if (!handlers || !original) return false;
  handlers.set("tools/list", async (...args: any[]) => {
    const listed = await original(...args);
    return { ...listed, tools: (listed?.tools ?? []).filter((tool: any) => !hidden.has(tool.name)) };
  });
  return true;
}
