// v0.24.14: định hình kết quả tool để giảm token, và gói ngữ cảnh cho kết nối mới.
type ToolOutput = { structuredContent?: Record<string, unknown>; content?: Array<{ type: string; text?: string }>; isError?: boolean; [key: string]: unknown };

function ascii(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}
function clip(value: unknown, max: number): string {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + "…" : text;
}
function rebuild(output: ToolOutput, structured: Record<string, unknown>): ToolOutput {
  const content = Array.isArray(output.content) ? output.content : [];
  const textIndex = content.findIndex((item) => item?.type === "text");
  const nextContent = content.slice();
  const text = JSON.stringify(structured);
  if (textIndex >= 0) nextContent[textIndex] = { ...nextContent[textIndex], text }; else nextContent.unshift({ type: "text", text });
  return { ...output, structuredContent: structured, content: nextContent };
}
function compactTask(task: Record<string, unknown>): Record<string, unknown> {
  const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints : null;
  if (!checkpoints || checkpoints.length <= 1) return task;
  return { ...task, checkpoints: checkpoints.slice(-1), checkpointCount: checkpoints.length, olderCheckpointsOmitted: checkpoints.length - 1, _nhdNote: "Older checkpoints omitted to save tokens; task_run action=status returns full history." };
}
function relevance(query: string, text: string): number {
  const tokens = [...new Set(ascii(query).split(/[^a-z0-9_.]+/).filter((token) => token.length >= 3))];
  const hay = ascii(text);
  return tokens.reduce((score, token) => score + (hay.includes(token) ? 1 : 0), 0);
}

export function shapeToolOutput(name: string, input: unknown, output: unknown): unknown {
  const out = output as ToolOutput;
  if (!out || typeof out !== "object" || out.isError || !out.structuredContent || typeof out.structuredContent !== "object") return output;
  const structured = out.structuredContent as Record<string, unknown>;
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    if ((name === "task_run" && !["status", "list"].includes(String(args.action ?? ""))) || name === "task_run_checkpoint" || name === "task_run_step") {
      const shaped = compactTask(structured);
      return shaped === structured ? output : rebuild(out, shaped);
    }
    if (name === "runtime_identity") {
      const { authority: _authority, ...rest } = structured as Record<string, any>;
      if (rest.release?.previous) rest.release = { ...rest.release, previous: { id: rest.release.previous.id, version: rest.release.previous.version, path: rest.release.previous.path } };
      return rebuild(out, rest);
    }
    if (name === "tool_governor" && String(args.action ?? "") === "plan") {
      const plan = { ...(structured as Record<string, any>) };
      const text = String(args.text ?? "");
      const pack = plan.memoryPack && typeof plan.memoryPack === "object" ? { ...plan.memoryPack } : null;
      if (pack) {
        if (Array.isArray(pack.projectFacts)) {
          const ranked = pack.projectFacts.map((fact: any) => ({ fact, score: relevance(text, `${fact?.key ?? ""} ${fact?.value ?? ""}`) + (fact?.category === "working_state" ? 0.5 : 0) }));
          ranked.sort((a: any, b: any) => b.score - a.score);
          pack.projectFactsOmitted = Math.max(0, pack.projectFacts.length - 5);
          pack.projectFacts = ranked.slice(0, 5).map(({ fact }: any) => ({ ...fact, value: clip(fact?.value, 400) }));
        }
        for (const key of ["globalPreferences", "projectPreferences"]) if (Array.isArray(pack[key])) pack[key] = pack[key].map((pref: any) => ({ key: pref?.key, value: clip(pref?.value, 300) }));
        if (Array.isArray(pack.similarTasks)) pack.similarTasks = pack.similarTasks.slice(0, 3).map((task: any) => ({ id: task?.id, state: task?.state, objective: clip(task?.objective, 300), summary: clip(task?.summary, 300) }));
        if (pack.recipe && pack.priorRecipe) delete pack.priorRecipe;
        plan.memoryPack = pack;
      }
      if (plan.memoryResolver?.priorRecipe && pack?.recipe) plan.memoryResolver = { ...plan.memoryResolver, priorRecipe: "see memoryPack.recipe" };
      return rebuild(out, plan);
    }
  } catch { return output; }
  return output;
}

function findFirst(value: unknown, key: string, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const record = value as Record<string, unknown>;
  if (key in record && record[key] !== null && record[key] !== "") return record[key];
  for (const child of Object.values(record)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const found = findFirst(child, key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function buildContextHeader(bootstrap: unknown, agent: string, maxChars = 2_000): string | null {
  if (!bootstrap || typeof bootstrap !== "object") return null;
  if ((bootstrap as any).available === false) return null;
  const project = findFirst(bootstrap, "name") ?? findFirst(bootstrap, "root");
  const rootPath = findFirst(bootstrap, "root");
  const parts = [
    `NHD context (auto, new connection: ${clip(agent, 60)})`,
    project ? `Project: ${clip(project, 160)}${rootPath && rootPath !== project ? ` [${clip(rootPath, 200)}]` : ""}` : "",
    findFirst(bootstrap, "taskId") ? `Task: ${findFirst(bootstrap, "taskId")} (${findFirst(bootstrap, "taskState") ?? "?"})` : "",
    findFirst(bootstrap, "objective") ? `Objective: ${clip(findFirst(bootstrap, "objective"), 600)}` : "",
    findFirst(bootstrap, "nextAction") ? `Next: ${clip(findFirst(bootstrap, "nextAction"), 500)}` : "",
    "Full context: context_bootstrap; specific facts: context_recall. Memory is context, never authorization.",
  ].filter(Boolean);
  if (parts.length <= 2) return null;
  return clip(parts.join("\n"), maxChars);
}

export class ContextHandshakeService {
  private readonly seen = new Map<string, number>();
  constructor(private readonly build: (agent: string) => string | null, private readonly idleMs = 2 * 60 * 60 * 1000) {}
  markSeen(key: string, now = Date.now()) { this.seen.set(key, now); }
  take(key: string, agent: string, now = Date.now()): string | null {
    const last = this.seen.get(key);
    this.seen.set(key, now);
    if (this.seen.size > 500) { for (const [k, at] of this.seen) if (now - at > this.idleMs) this.seen.delete(k); }
    if (last !== undefined && now - last < this.idleMs) return null;
    try { return this.build(agent); } catch { return null; }
  }
}

export function prependText(output: unknown, text: string): unknown {
  const out = output as ToolOutput;
  if (!out || typeof out !== "object") return output;
  const content = Array.isArray(out.content) ? out.content : [];
  const next: Record<string, unknown> = { ...out, content: [{ type: "text", text }, ...content] };
  // v0.24.15: Claude Code hiển thị structuredContent và ẩn content, nên header phải nằm cả trong structuredContent.
  const structured = (out as any).structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) next.structuredContent = { _nhdContext: text, ...structured };
  return next;
}
