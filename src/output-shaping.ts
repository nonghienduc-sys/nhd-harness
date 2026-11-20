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


// Retain the contextual memory that determines how the Brain performs the task.
function compactGovernorMemory(value: unknown, query: string): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pack = { ...(value as Record<string, any>) };
  if (Array.isArray(pack.projectFacts)) {
    const ranked = pack.projectFacts.map((fact: any) => ({ fact, score:
      relevance(query, String(fact?.key ?? "") + " " + String(fact?.value ?? "")) +
        (fact?.category === "working_state" ? 0.5 : 0) }));
    ranked.sort((a: any, b: any) => b.score - a.score);
    pack.projectFactsOmitted = Math.max(0, ranked.length - 5);
    pack.projectFacts = ranked.slice(0, 5).map(({ fact }: any) => ({ ...fact, value: clip(fact?.value, 400) }));
  }
  for (const key of ["globalPreferences", "projectPreferences"]) {
    if (Array.isArray(pack[key])) pack[key] = pack[key].map((pref: any) =>
      ({ key: pref?.key, value: clip(pref?.value, 300) }));
  }
  if (Array.isArray(pack.similarTasks)) pack.similarTasks = pack.similarTasks.slice(0, 3).map((task: any) =>
    ({ id: task?.id, state: task?.state, objective: clip(task?.objective, 300), summary: clip(task?.summary, 300) }));
  if (pack.recipe && pack.priorRecipe) delete pack.priorRecipe;
  return pack;
}
function compactGovernorResolver(value: unknown, pack: Record<string, any> | undefined): unknown {
  if (!value || typeof value !== "object") return value;
  const resolver = { ...(value as Record<string, any>) };
  if (resolver.priorRecipe && pack?.recipe) resolver.priorRecipe = "see memoryPack.recipe";
  return resolver;
}

// Ritual replies retain execution decisions; verbose:true exposes the original payload.
export function compactRitualOutput(name: string, source: Record<string, unknown>, input: Record<string, unknown> = {}): Record<string, unknown> | null {
  const x = source as Record<string, any>;
  if (name === "workstation_plan") {
    const e = x.executionPlan ?? {};
    const route = e.route ?? x.plan ?? {};
    const risk = e.risk ?? {};
    const compact = {
      executionPlan: {
        schemaVersion: e.schemaVersion, kind: e.kind,
        executesActions: e.executesActions, grantsAuthorization: e.grantsAuthorization,
        intent: { domain: e.intent?.domain, operation: e.intent?.operation },
        route: { route: route.route, reason: clip(route.reason, 125), requiresConfirmation: route.requiresConfirmation, readOnly: route.readOnly,
          verification: { kind: route.verification?.kind, onAmbiguous: route.verification?.onAmbiguous } },
        lane: { lane: e.lane?.lane, available: e.lane?.available, escalation: e.lane?.escalation, hostForegroundAllowed: e.lane?.hostForegroundAllowed },
        risk: { score: risk.score, level: risk.level, confirmationMode: risk.confirmationMode, reasons: risk.reasons, transactionRequired: risk.transactionRequired },
        qa: { level: e.qa?.level, visualReviewRequired: e.qa?.visualReviewRequired },
        safety: { neverReplayAmbiguousExecution: e.safety?.neverReplayAmbiguousExecution, authorizationStillEnforcedByActionTool: e.safety?.authorizationStillEnforcedByActionTool },
        warnings: e.artifact?.warnings ?? e.artifactPlan?.warnings ?? [],
        governor: { taskClass: e.governor?.taskClass, recommendedTools: e.governor?.recommendedTools,
          avoidUnlessNeeded: e.governor?.avoidUnlessNeeded },
        intentPolicy: { mode: e.intentPolicy?.mode, methodLocked: e.intentPolicy?.methodLocked,
          goalOpen: e.intentPolicy?.goalOpen, verificationRequired: e.intentPolicy?.verificationRequired },
      },
      plan: { route: route.route, requiresConfirmation: route.requiresConfirmation, readOnly: route.readOnly,
        recovery: { neverRepeatAfterAmbiguousExecution: route.recovery?.neverRepeatAfterAmbiguousExecution } },
      capabilities: { office: { liveWriteApplications: e.capabilities?.office?.liveWriteApplications } },
      riskLevel: risk.level, confirmationMode: risk.confirmationMode,
    };
    return compact as Record<string, unknown>;
  }
  if (name === "runtime_identity") {
    const { authority: _authority, release, consistency, ...top } = x;
    const shortRelease = release ? {
      generation: release.generation,
      active: release.active ? { id: release.active.id, path: release.active.path } : null,
      current: release.current ? { id: release.current.id, version: release.current.version } : null,
      previous: release.previous ? { id: release.previous.id, version: release.previous.version, path: release.previous.path } : null,
      candidate: release.candidate ? { id: release.candidate.id, version: release.candidate.version } : null,
    } : undefined;
    return { ...top, release: shortRelease,
      consistency: consistency ? { sourceMatchesProduction: consistency.sourceMatchesProduction,
        currentReleaseMatchesActive: consistency.currentReleaseMatchesActive,
        deploymentHashAvailable: consistency.deploymentHashAvailable } : undefined };
  }
  if (name === "harness_mode") return source;
  if (name === "tool_governor") {
    const memoryPack = compactGovernorMemory(x.memoryPack, String(input.text ?? ""));
    return {
      memoryPack,
      memoryResolver: compactGovernorResolver(x.memoryResolver, memoryPack),
      planId: x.planId, root: x.root, taskClass: x.taskClass, projectProfile: x.projectProfile,
      intentPolicy: { mode: x.intentPolicy?.mode, methodLocked: x.intentPolicy?.methodLocked,
        goalOpen: x.intentPolicy?.goalOpen, verificationRequired: x.intentPolicy?.verificationRequired },
      directFastLane: x.directFastLane, recommendedTools: x.recommendedTools,
      qualityFloor: x.qualityFloor,
      toolBudget: x.toolBudget ? { kind: x.toolBudget.kind, expectedCalls: x.toolBudget.expectedCalls, softLimit: x.toolBudget.softLimit } : undefined,
      escalationTriggers: x.escalationTriggers, warnings: x.artifactPlan?.warnings ?? [],
    };
  }
  return null;
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
    if (args.verbose === true && ["workstation_plan", "runtime_identity", "harness_mode", "tool_governor"].includes(name)) return output;
    const ritual = name === "workstation_plan" || name === "runtime_identity" ||
      (name === "harness_mode" && args.action === "status") ||
      (name === "tool_governor" && args.action === "plan");
    if (ritual) {
      const compact = compactRitualOutput(name, structured, args);
      const limit = name === "workstation_plan" ? 2500 : 1500;
      const length = compact ? JSON.stringify(name === "tool_governor"
        ? { ...compact, memoryPack: undefined } : compact).length : 0;
      if (compact && length <= limit) return rebuild(out, compact);
      if (compact) {
        const core = name === "workstation_plan" ? {
          executionPlan: { route: (compact as any).executionPlan?.route, lane: (compact as any).executionPlan?.lane,
            risk: (compact as any).executionPlan?.risk, warnings: (compact as any).executionPlan?.warnings,
            governor: (compact as any).executionPlan?.governor,
            intentPolicy: (compact as any).executionPlan?.intentPolicy },
          plan: (compact as any).plan, capabilities: (compact as any).capabilities,
          riskLevel: (compact as any).riskLevel, confirmationMode: (compact as any).confirmationMode,
        } : name === "runtime_identity" ? {
          productionVersion: structured.productionVersion, sourceVersion: structured.sourceVersion,
          runtimePath: structured.runtimePath, rollbackVersion: structured.rollbackVersion,
          rollbackPath: structured.rollbackPath,
        } : name === "tool_governor" ? {
          planId: structured.planId, taskClass: structured.taskClass,
          memoryPack: (compact as any).memoryPack, memoryResolver: (compact as any).memoryResolver,
          recommendedTools: structured.recommendedTools, escalationTriggers: structured.escalationTriggers,
          warnings: (structured as any).artifactPlan?.warnings ?? [],
        } : compact;
        return rebuild(out, core);
      }
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
    "Role: you are the Brain - plan, delegate hands-on work via delegate_task, review (BRAIN ROLE in server instructions).",
    "Full context: context_bootstrap; specific facts: context_recall. Memory is context, never authorization.",
  ].filter(Boolean);
  if (parts.length <= 3) return null;
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


// Only the advertised schema is altered. The SDK's zod input validation is untouched.
export function omitAdvertisedSchema<T extends { inputSchema: Record<string, unknown> }>(tool: T): T {
  if (!tool.inputSchema || !Object.prototype.hasOwnProperty.call(tool.inputSchema, "$schema")) return tool;
  const { $schema: _dialect, ...inputSchema } = tool.inputSchema;
  return { ...tool, inputSchema };
}

// Preserve images, isError and the independently delivered NHD context header.
export function formatForClient(name: string, output: unknown, clientName: string | undefined, structuredOnlyClients: string[]): unknown {
  const out = output as ToolOutput;
  if (!out || typeof out !== "object" || out.isError || !out.structuredContent ||
      typeof out.structuredContent !== "object" || !Array.isArray(out.content)) return output;
  const i = out.content.findIndex((item) => item?.type === "text" && !String(item.text ?? "").startsWith("NHD context"));
  if (i < 0) return output;
  const match = Boolean(clientName) && structuredOnlyClients.some((pattern) =>
    typeof pattern === "string" && pattern.trim().length > 0 &&
    clientName!.toLowerCase().includes(pattern.trim().toLowerCase()));
  const keys = Object.keys(out.structuredContent);
  const summary = "Tool: " + name + "; ok; keys: " + keys.slice(0, 12).join(", ") + ". Dữ liệu đầy đủ trong structuredContent";
  const text = match ? summary.slice(0, 400) : JSON.stringify(out.structuredContent);
  const content = out.content.slice();
  content[i] = { ...content[i], text };
  return { ...out, content };
}
