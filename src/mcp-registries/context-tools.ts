import { z } from "zod";
import type { TaskRunState } from "../task-runtime.js";
import type { PlanState } from "../plan-state.js";
import { readOnly, preview, navigation, result, failure, resultWithImages, type ToolRegistryContext } from "./shared.js";

// v0.24.15: checkpoint used to echo the whole refreshed bootstrap (~170 KB). Keep the write
// and its side effects, but return only what confirms the save; full context stays on context_bootstrap.
export function compactCheckpointResult(stored: any) {
  const { bootstrap, ...rest } = stored ?? {};
  if (!bootstrap || typeof bootstrap !== "object") return stored;
  const clip = (value: unknown, max: number) => { const text = typeof value === "string" ? value : ""; return text.length > max ? `${text.slice(0, max)}…` : text; };
  const actions = Array.isArray(bootstrap.reconciliation?.actions) ? bootstrap.reconciliation.actions : [];
  return {
    ...rest,
    bootstrap: {
      available: bootstrap.available,
      runtimeVersion: bootstrap.runtimeVersion,
      activeProject: bootstrap.activeProject ? { name: bootstrap.activeProject.name, root: bootstrap.activeProject.root } : undefined,
      resumePrompt: clip(bootstrap.resumePrompt, 1200) || undefined,
      reconciliationActions: actions.slice(0, 10),
      omitted: true,
      hint: "Full context omitted to save tokens; call context_bootstrap (or pass include_bootstrap=true) when needed.",
    },
  };
}

export function registerContextTools(ctx: ToolRegistryContext) {
  const { server, runtime } = ctx;
  const { config, store, files, screen, projects, taskRuns, workspaceMemory, planState } = runtime;
  const { resultPayloadGateway } = ctx;
  if (resultPayloadGateway) {
    server.registerTool("context_payload_artifact", { description: "Read or search a bounded raw artifact created by the Result Payload Gateway after a large read-only tool result was compacted. Artifact IDs are content-addressed SHA-256 values; this tool cannot read arbitrary filesystem paths.", inputSchema: { action: z.enum(["status","search","pack","read"]), artifact_id: z.string().regex(/^[a-f0-9]{64}$/).optional(), query: z.string().min(1).max(2000).optional(), start_char: z.number().int().min(0).optional(), max_chars: z.number().int().min(100).max(50000).optional(), limit: z.number().int().min(1).max(20).optional(), context_chars: z.number().int().min(200).max(2000).optional() }, annotations: readOnly }, async (input) => {
      try {
        if (input.action === "status") return result(resultPayloadGateway.status());
        if (!input.artifact_id) throw new Error("artifact_id is required.");
        if (input.action === "search") {
          if (!input.query) throw new Error("query is required for artifact search.");
          return result(resultPayloadGateway.searchArtifact(input.artifact_id, input.query, input.limit ?? 8, input.context_chars ?? 900));
        }
        if (input.action === "pack") {
          if (!input.query) throw new Error("query is required for artifact evidence pack.");
          return result(resultPayloadGateway.evidencePack(input.artifact_id, input.query, input.limit ?? 8, input.max_chars ?? 8000, input.context_chars ?? 1000));
        }
        return result(resultPayloadGateway.readArtifactById(input.artifact_id, input.start_char ?? 0, input.max_chars ?? 12000));
      } catch (e) { return failure(e); }
    });
  }
  const syncTaskMemory = (run: any, event: string, semanticSummary?: string, nextAction?: string) => {
    if (!workspaceMemory || !run?.root) return;
    try {
      workspaceMemory.recordWorkingState(run.root, {
        operation: `task_${event}`,
        status: String(run.state ?? ''),
        artifact: String(run.id ?? ''),
        source: 'task_runtime_auto_hook',
      });
      if (semanticSummary) {
        const terminalTask = new Set(['completed', 'failed', 'cancelled', 'expired']).has(String(run.state ?? ''));
        const candidates = taskRuns ? taskRuns.list(undefined, 100).filter((item: any) =>
          String(item.root ?? '') === String(run.root) &&
          !new Set(['completed', 'failed', 'cancelled', 'expired']).has(String(item.state ?? '')) &&
          String(item.id ?? '') !== String(run.id ?? '')
        ) : [];
        const nextRun = candidates.find((item: any) => ['running', 'waiting_confirmation', 'paused'].includes(String(item.state ?? '')))
          ?? candidates.find((item: any) => String(item.state ?? '') === 'planned');
        const promotedNextAction = terminalTask && nextRun
          ? `Continue task ${nextRun.id}: ${String(nextRun.objective ?? '')}`
          : nextAction;
        const summary = terminalTask && nextRun
          ? `Completed task ${run.id}: ${String(run.objective ?? '')}. Next active task: ${nextRun.id}: ${String(nextRun.objective ?? '')}.`
          : `Task ${run.id}: ${semanticSummary}`;
        const terminalWithoutNext = terminalTask && !nextRun;
        const cleanTerminal = terminalWithoutNext && ['completed', 'cancelled'].includes(String(run.state ?? ''));
        const taskFacts = nextRun
          ? [
              { key: 'working.current_task.id', value: String(nextRun.id), category: 'working_state', confidence: 'verified' as const, source: 'task_runtime_auto_hook' },
              { key: 'working.current_task.status', value: String(nextRun.state ?? ''), category: 'working_state', confidence: 'verified' as const, source: 'task_runtime_auto_hook' },
              { key: 'working.current_task.objective', value: String(nextRun.objective ?? ''), category: 'working_state', confidence: 'confirmed' as const, source: 'task_runtime_auto_hook' },
            ]
          : terminalTask
            ? [
                { key: 'working.last_task.id', value: String(run.id), category: 'working_state', confidence: 'verified' as const, source: 'task_runtime_auto_hook' },
                { key: 'working.last_task.status', value: String(run.state ?? ''), category: 'working_state', confidence: 'verified' as const, source: 'task_runtime_auto_hook' },
                { key: 'working.last_task.objective', value: String(run.objective ?? ''), category: 'working_state', confidence: 'confirmed' as const, source: 'task_runtime_auto_hook' },
              ]
            : [
                { key: 'working.current_task.id', value: String(run.id), category: 'working_state', confidence: 'verified' as const, source: 'task_runtime_auto_hook' },
                { key: 'working.current_task.status', value: String(run.state ?? ''), category: 'working_state', confidence: 'verified' as const, source: 'task_runtime_auto_hook' },
                { key: 'working.current_task.objective', value: String(run.objective ?? ''), category: 'working_state', confidence: 'confirmed' as const, source: 'task_runtime_auto_hook' },
              ];
        const clearFacts = terminalWithoutNext
          ? ['working.current_task.id', 'working.current_task.status', 'working.current_task.objective', ...(cleanTerminal ? ['workspace.current_objective'] : [])]
          : [];
        workspaceMemory.checkpoint(run.root, {
          kind: 'semantic',
          summary,
          nextAction: promotedNextAction,
          objective: terminalTask && nextRun ? String(nextRun.objective ?? '') : String(run.objective ?? ''),
          facts: taskFacts,
          clearFacts,
        });
      }
    } catch {}
  };
  if (taskRuns) {
    const taskState = z.enum(["planned","running","waiting_confirmation","paused","completed","failed","cancelled","expired"]);
    const refKind = z.enum(["file","document","project","url","message","receipt","other"]);
    const assertTaskExecutionAllowed = () => { if (config.emergencyStop) throw new Error("Emergency Stop is enabled; task execution cannot start or resume."); };

    server.registerTool("task_run", { description: "Create, inspect, start/pause, complete, fail, or cancel a durable bounded task run. For a brand-new workstation task, omit root: MCP automatically creates a persistent project folder and binds the task to it. Supply root only when intentionally continuing or attaching to an existing project. This tool manages task state and explicit task-scoped authorization/capability leases; it never executes Browser, Office, Desktop, filesystem, or Terminal actions. Capability leases are app/action scoped, bounded by TTL/count, and never override platform hard-deny categories.", inputSchema: { action: z.enum(["create","list","status","authorize","revoke_authorization","grant_capability","list_capabilities","revoke_capability","start","pause","complete","fail","cancel"]), run_id: z.string().optional(), objective: z.string().max(20000).optional(), root: z.string().optional(), max_steps: z.number().int().min(1).max(100).optional(), max_runtime_minutes: z.number().int().min(1).max(1440).optional(), conversation_id: z.string().max(1000).optional(), max_risk_level: z.enum(["moderate","high"]).optional(), ttl_minutes: z.number().int().min(1).max(1440).optional(), app_scope: z.string().min(1).max(200).optional(), capability_actions: z.array(z.enum(["send","submit","save","publish","post","reply","comment","create","confirm","apply","register","book","reserve","login","delete","upload","download","restart","external_protocol"])).min(1).max(16).optional(), max_count: z.number().int().min(1).max(100).optional(), lease_id: z.string().max(256).optional(), state: taskState.optional(), limit: z.number().int().min(1).max(200).optional(), note: z.string().max(2000).optional() }, annotations: navigation }, async (input) => {
      try {
        if (input.action === "create") {
          assertTaskExecutionAllowed();
          if (!input.objective) throw new Error("objective is required.");
          const autoProject = input.root ? null : projects.autoInitTaskProject(input.objective, "mixed");
          const projectRoot = input.root ?? autoProject!.root;
          let run = taskRuns.create({ objective: input.objective, root: projectRoot, maxSteps: input.max_steps, maxRuntimeMs: input.max_runtime_minutes == null ? undefined : input.max_runtime_minutes * 60_000 });
          let projectBinding: unknown = null;
          if (autoProject) {
            projectBinding = projects.bindTask(autoProject.root, run.id, run.objective);
            run = taskRuns.addReference(run.id, { kind: "project", label: autoProject.name, location: autoProject.root, fingerprint: autoProject.projectId });
          }
          syncTaskMemory(run, "create");
          let conversationBinding: unknown = null;
          if (workspaceMemory) {
            try {
              if (input.conversation_id) {
                workspaceMemory.bindConversation(projectRoot, input.conversation_id, { source: "task_run_create" });
                conversationBinding = workspaceMemory.bindConversationTask(input.conversation_id, run.id, "task_run_create");
              } else {
                conversationBinding = workspaceMemory.bindLatestConversationToTask(projectRoot, run.id, "task_run_create");
              }
            } catch {}
          }
          if (autoProject && workspaceMemory) {
            try {
              workspaceMemory.checkpoint(autoProject.root, {
                kind: "semantic",
                summary: `Created project folder and durable task binding for: ${run.objective}`,
                objective: run.objective,
                facts: [
                  { key: "project.auto_created", value: "true", category: "project_binding", confidence: "verified", source: "task_run_create" },
                  { key: "project.folder", value: autoProject.root, category: "project_binding", confidence: "verified", source: "task_run_create" },
                  { key: "project.id", value: autoProject.projectId, category: "project_binding", confidence: "verified", source: "task_run_create" },
                ],
              });
            } catch {}
          }
          return result(autoProject ? { ...run, project: autoProject, projectBinding, conversationBinding } : { ...run, conversationBinding });
        }
        if (input.action === "list") return result({ runs: taskRuns.list(input.state as TaskRunState | undefined, input.limit ?? 50) });
        if (!input.run_id) throw new Error("run_id is required.");
        if (input.action === "status") return result(taskRuns.get(input.run_id));
        if (input.action === "authorize") { assertTaskExecutionAllowed(); return result(taskRuns.authorize(input.run_id, { maxRiskLevel: input.max_risk_level, ttlMinutes: input.ttl_minutes })); }
        if (input.action === "revoke_authorization") return result(taskRuns.revokeAuthorization(input.run_id));
        if (input.action === "grant_capability") {
          assertTaskExecutionAllowed();
          if (!input.app_scope || !input.capability_actions?.length) throw new Error("app_scope and capability_actions are required.");
          return result(taskRuns.grantCapability(input.run_id, { appScope: input.app_scope, actions: input.capability_actions, maxCount: input.max_count, ttlMinutes: input.ttl_minutes }));
        }
        if (input.action === "list_capabilities") return result({ leases: taskRuns.listCapabilities(input.run_id) });
        if (input.action === "revoke_capability") return result(taskRuns.revokeCapability(input.run_id, input.lease_id));
        if (input.action === "start") { assertTaskExecutionAllowed(); const run = taskRuns.start(input.run_id); syncTaskMemory(run, "start", `Started task: ${run.objective}`); let conversationBinding: unknown = null; if (workspaceMemory && run.root) { try { if (input.conversation_id) { workspaceMemory.bindConversation(run.root, input.conversation_id, { source: "task_run_start" }); conversationBinding = workspaceMemory.bindConversationTask(input.conversation_id, run.id, "task_run_start"); } else { conversationBinding = workspaceMemory.bindLatestConversationToTask(run.root, run.id, "task_run_start"); } } catch {} } return result({ ...run, conversationBinding }); }
        if (input.action === "pause") { const run = taskRuns.pause(input.run_id); syncTaskMemory(run, "pause", `Paused task: ${run.objective}`, "Resume the task from its latest verified state."); return result(run); }
        if (input.action === "complete") { const run = taskRuns.completeRun(input.run_id); syncTaskMemory(run, "complete", `Completed task: ${run.objective}`); return result(run); }
        if (input.action === "fail") { const run = taskRuns.failRun(input.run_id, input.note); syncTaskMemory(run, "fail", `Task failed: ${input.note ?? run.objective}`, "Review the failure and decide the next safe action."); return result(run); }
        const run = taskRuns.cancel(input.run_id, input.note); syncTaskMemory(run, "cancel", `Task cancelled: ${input.note ?? run.objective}`); return result(run);
      } catch (e) { return failure(e); }
    });

    server.registerTool("task_run_step", { description: "Record lifecycle metadata for one durable task step. It never executes or approves the routed workstation action; call the existing routed tool separately, use its own confirmation flow, then record verified outcome/receipt linkage here. The confirm action only records task-state confirmation and never substitutes for a workstation tool confirmation. Interrupted or ambiguous actions must not be replayed automatically.", inputSchema: { action: z.enum(["begin","confirm","complete"]), run_id: z.string(), step_id: z.string().optional(), route: z.string().max(200).optional(), description: z.string().max(2000).optional(), requires_confirmation: z.boolean().optional(), verified: z.boolean().optional(), outcome: z.enum(["success","failed"]).optional(), receipt_id: z.string().max(500).optional(), note: z.string().max(2000).optional() }, annotations: navigation }, async (input) => {
      try {
        if (input.action === "begin") { assertTaskExecutionAllowed(); if (!input.route || !input.description) throw new Error("route and description are required."); const run = taskRuns.beginStep(input.run_id, { route: input.route, description: input.description, requiresConfirmation: input.requires_confirmation }); syncTaskMemory(run, `step_begin:${input.route}`); return result(run); }
        if (!input.step_id) throw new Error("step_id is required.");
        if (input.action === "confirm") { assertTaskExecutionAllowed(); return result(taskRuns.confirmStep(input.run_id, input.step_id)); }
        if (input.verified == null || !input.outcome) throw new Error("verified and outcome are required for completion.");
        const run = taskRuns.completeStep(input.run_id, input.step_id, { verified: input.verified, outcome: input.outcome, receiptId: input.receipt_id, note: input.note }); syncTaskMemory(run, `step_complete:${input.step_id}`, input.outcome === "success" ? `Verified task step ${input.step_id} completed successfully.` : `Task step ${input.step_id} failed.`, "Continue from the latest verified task state."); return result(run);
      } catch (e) { return failure(e); }
    });

    server.registerTool("task_run_reference", { description: "Add a bounded typed reference to durable task memory. File/document references are also bound to the task project, so later tabs can resolve that artifact to the same project even when the file lives outside the project folder. Stores only metadata; it does not copy the referenced content.", inputSchema: { run_id: z.string(), kind: refKind, label: z.string().min(1).max(500), location: z.string().min(1).max(5000), fingerprint: z.string().max(500).optional() }, annotations: navigation }, async (input) => {
      try {
        const run = taskRuns.addReference(input.run_id, input);
        let projectBinding: unknown = null;
        if (workspaceMemory && run.root && (input.kind === "file" || input.kind === "document")) {
          try { projectBinding = workspaceMemory.bindLocation(run.root, input.location, input.kind, "task_run_reference"); } catch {}
        }
        return result({ ...run, projectBinding });
      } catch (e) { return failure(e); }
    });

    server.registerTool("task_run_checkpoint", { description: "Store a bounded durable task checkpoint summary and next-action note. This is memory metadata only; it never executes the next action and cannot checkpoint while a step is active.", inputSchema: { run_id: z.string(), summary: z.string().min(1).max(20000), next_action: z.string().max(4000).optional() }, annotations: navigation }, async ({ run_id, summary, next_action }) => { try { const run = taskRuns.checkpoint(run_id, { summary, nextAction: next_action }); syncTaskMemory(run, "checkpoint", summary, next_action); return result(run); } catch (e) { return failure(e); } });

    server.registerTool("task_protocol_status", { description: "Return a read-only MCP Tasks 2026-style projection of one durable NHD task. This is a compatibility adapter only; it does not claim native io.modelcontextprotocol/tasks wire support and never executes or authorizes workstation actions.", inputSchema: { run_id: z.string() }, annotations: readOnly }, async ({ run_id }) => { try { return result(taskRuns.protocolTask(run_id)); } catch (e) { return failure(e); } });
    server.registerTool("task_agent_cycle", { description: "Return the next safe deterministic agent-cycle directive for a durable task: begin the next bounded step, verify the current step, request input, or stop. It is coordination metadata only and never executes tools, approves side effects, or replays ambiguous actions.", inputSchema: { run_id: z.string() }, annotations: readOnly }, async ({ run_id }) => { try { return result(taskRuns.agentCycle(run_id)); } catch (e) { return failure(e); } });
  }

  if (planState) {
    const planStateEnum = z.enum(["planned","running","paused","blocked","completed","failed","cancelled"]);
    const phaseInput = z.object({ key:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/).optional(), title:z.string().min(1).max(500), objective:z.string().max(4000).optional(), required:z.boolean().optional() });
    server.registerTool("task_plan", { description: "Create and manage a durable ordered multi-phase plan for upgrades, projects or workflows. Phase state survives ChatGPT/MCP/Windows restarts. Verifying the current phase automatically advances to the next phase; the plan completes only after every required phase is verified. This is coordination metadata only and never executes or authorizes workstation actions.", inputSchema: { action:z.enum(["create","list","status","start","pause","resume","verify_phase","block_phase","fail_phase","retry_phase","cancel"]), plan_id:z.string().max(256).optional(), kind:z.enum(["upgrade","project","workflow","general"]).optional(), title:z.string().max(500).optional(), objective:z.string().max(4000).optional(), root:z.string().max(5000).optional(), task_run_id:z.string().max(256).optional(), phases:z.array(phaseInput).min(1).max(64).optional(), phase_key:z.string().max(80).optional(), state:planStateEnum.optional(), summary:z.string().max(8000).optional(), note:z.string().max(4000).optional(), receipt_id:z.string().max(500).optional(), limit:z.number().int().min(1).max(200).optional() }, annotations:navigation }, async(input) => {
      try {
        if (input.action === "create") { if (!input.title || !input.phases?.length) throw new Error("title and phases are required."); return result(planState.create({kind:input.kind,title:input.title,objective:input.objective,root:input.root,taskRunId:input.task_run_id,phases:input.phases})); }
        if (input.action === "list") return result({ stats:planState.stats(), plans:planState.list({root:input.root,taskRunId:input.task_run_id,state:input.state as PlanState|undefined,limit:input.limit}) });
        if (!input.plan_id) throw new Error("plan_id is required.");
        if (input.action === "status") return result(planState.get(input.plan_id));
        if (input.action === "start") return result(planState.start(input.plan_id));
        if (input.action === "pause") return result(planState.pause(input.plan_id,input.note));
        if (input.action === "resume") return result(planState.resume(input.plan_id));
        if (input.action === "cancel") return result(planState.cancel(input.plan_id,input.note));
        if (!input.phase_key) throw new Error("phase_key is required for phase actions.");
        if (input.action === "verify_phase") return result(planState.verifyPhase(input.plan_id,input.phase_key,{summary:input.summary,receiptId:input.receipt_id}));
        if (input.action === "block_phase") return result(planState.blockPhase(input.plan_id,input.phase_key,input.note ?? "Blocked."));
        if (input.action === "fail_phase") return result(planState.failPhase(input.plan_id,input.phase_key,input.note ?? "Phase failed."));
        return result(planState.retryPhase(input.plan_id,input.phase_key,input.note));
      } catch(e) { return failure(e); }
    });
  }

  if (workspaceMemory) {
    server.registerTool("context_bootstrap", { description: "Restore cross-chat workspace context with quality-preserving progressive hydration. Auto mode keeps the entire authoritative core (bound task/step, latest semantic checkpoint, all current structured facts, decisions and working state) while deferring only bulky historical collections and retrieving relevant history. It automatically falls back to full context for history-sensitive or ambiguous cases. Deferred context remains retrievable through context_recall/context_chat_history/project_memory; memory never grants authorization.", inputSchema: { root: z.string().optional(), conversation_id: z.string().max(1000).optional(), max_chars: z.number().int().min(2000).max(50000).optional(), recent_limit: z.number().int().min(1).max(20).optional(), activate: z.boolean().optional(), mode: z.enum(["auto","full","progressive"]).optional(), query: z.string().max(2000).optional() }, annotations: navigation }, async ({ root, conversation_id, max_chars, recent_limit, activate, mode, query }) => { try { return result(workspaceMemory.bootstrap(root, { maxChars: max_chars, recentLimit: recent_limit, activate, conversationId: conversation_id, mode, query })); } catch (e) { return failure(e); } });
    server.registerTool("context_find_project", { description: "Find previously registered projects by project name, path, or project id. Use this before context_bootstrap when the user names an existing project but its exact root is not already known.", inputSchema: { query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(30).optional() }, annotations: readOnly }, async ({ query, limit }) => { try { return result(workspaceMemory.findProjects(query, limit ?? 10)); } catch (e) { return failure(e); } });
    server.registerTool("context_chat_history", { description: "Read the project-bound visible chat journal. It contains only captured user/assistant messages, separate from semantic checkpoint memory. Use a conversation_id to scope one chat or omit it for recent project history.", inputSchema: { root: z.string().optional(), conversation_id: z.string().max(1000).optional(), limit: z.number().int().min(1).max(300).optional(), max_chars: z.number().int().min(1000).max(100000).optional() }, annotations: readOnly }, async ({ root, conversation_id, limit, max_chars }) => { try { return result(workspaceMemory.chatHistory(root, conversation_id, { limit, maxChars: max_chars })); } catch (e) { return failure(e); } });
    server.registerTool("context_chat_binding", { description: "Explicitly bind/rebind a ChatGPT conversation to a project and optionally to one durable task in that same project. This establishes Conversation → Project → Task affinity; rebinding the project clears an incompatible task binding.", inputSchema: { root: z.string().min(1), conversation_id: z.string().min(1).max(1000), task_run_id: z.string().max(256).optional(), page_title: z.string().max(500).optional(), url: z.string().max(2000).optional() }, annotations: navigation }, async ({ root, conversation_id, task_run_id, page_title, url }) => { try { const projectBinding = workspaceMemory.bindConversation(root, conversation_id, { pageTitle: page_title, url, source: "context_chat_binding" }); const taskBinding = task_run_id ? workspaceMemory.bindConversationTask(conversation_id, task_run_id, "context_chat_binding") : null; return result({ ...projectBinding, taskBinding }); } catch (e) { return failure(e); } });
    server.registerTool("context_checkpoint", { description: "Persist a bounded cross-chat checkpoint plus optional structured facts. Semantic checkpoints clear stale next-action state when next_action is omitted; facts may declare freshness/TTL and clear_facts can explicitly retire stale keys. kind=operational never overrides semantic work state. Never store credentials, full document bodies, full web pages, terminal output dumps, or hidden reasoning.", inputSchema: { root: z.string().optional(), kind: z.enum(["semantic","operational"]).optional(), summary: z.string().min(1).max(20000), next_action: z.string().max(4000).optional(), objective: z.string().max(4000).optional(), facts: z.array(z.object({ key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/), value: z.string().min(1).max(4000), category: z.string().max(80).optional(), confidence: z.enum(["verified","confirmed","inferred"]).optional(), source: z.string().max(1000).optional(), freshness_class: z.enum(["durable","project","session","environment"]).optional(), ttl_seconds: z.number().int().min(1).max(2592000).optional() })).max(64).optional(), clear_facts: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/)).max(64).optional(), task_run_id: z.string().max(256).optional(), include_bootstrap: z.boolean().optional().describe("Return the full refreshed bootstrap (large). Default false: a compact summary; call context_bootstrap when full context is needed.") }, annotations: navigation }, async ({ root, kind, summary, next_action, objective, facts, clear_facts, task_run_id, include_bootstrap }) => { try { const normalizedFacts = facts?.map(({ freshness_class, ttl_seconds, ...fact }) => ({ ...fact, freshnessClass: freshness_class, ttlMs: ttl_seconds == null ? undefined : ttl_seconds * 1000 })); const stored = workspaceMemory.checkpoint(root, { kind, summary, nextAction: next_action, objective, facts: normalizedFacts, clearFacts: clear_facts, taskRunId: task_run_id }, task_run_id); return result(include_bootstrap ? stored : compactCheckpointResult(stored)); } catch (e) { return failure(e); } });
    server.registerTool("context_daily_progress", { description: "Read, create, or update a project daily plan so the local dashboard can show whether today is complete. Store only bounded progress metadata; use update after verified milestones. It never executes workstation actions or grants authorization.", inputSchema: { action: z.enum(["get","set","update"]), root: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), title: z.string().max(500).optional(), note: z.string().max(1600).optional(), items: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/), label: z.string().min(1).max(300), target: z.number().positive().max(1000000), current: z.number().min(0).max(1000000).optional(), unit: z.string().max(50).optional() })).max(30).optional(), updates: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/), current: z.number().min(0).max(1000000).optional(), increment: z.number().min(-1000000).max(1000000).optional(), complete: z.boolean().optional() })).max(30).optional(), task_run_id: z.string().max(256).optional() }, annotations: navigation }, async ({ action, root, date, title, note, items, updates, task_run_id }) => { try { if (action === "get") return result(workspaceMemory.dailyProgress(root, date)); if (action === "set") { if (!title || !items?.length) throw new Error("title and items are required for set."); return result(workspaceMemory.setDailyPlan(root, { date, title, note, items, taskRunId: task_run_id }, task_run_id)); } if (!updates?.length) throw new Error("updates are required for update."); return result(workspaceMemory.updateDailyProgress(root, date, updates, note, task_run_id)); } catch (e) { return failure(e); } });
    server.registerTool("context_recall", { description: "Retrieve the most relevant bounded memory items for a specific question across structured facts, semantic/operational checkpoints, project chat journal, episodic events, decisions and durable tasks. Prefer this over loading broad memory when the user asks about a particular prior detail.", inputSchema: { root: z.string().optional(), query: z.string().min(1).max(2000), limit: z.number().int().min(1).max(30).optional() }, annotations: readOnly }, async ({ root, query, limit }) => {
      try {
        const recalled = workspaceMemory.recall(root, query, limit ?? 12);
        if (!root || !ctx.projectRag) return result(recalled);
        try {
          const evidence = await ctx.projectRag.query(root, query, Math.min(6, limit ?? 6), 4200);
          return result({ ...recalled, projectRag: evidence });
        } catch (ragError) {
          return result({ ...recalled, projectRag: { available: false,
            error: ragError instanceof Error ? ragError.message : String(ragError) } });
        }
      } catch (e) { return failure(e); }
    });
    server.registerTool("context_working_state", { description: "Store a bounded working-document pointer/status without copying document contents. Used for current application/path, last operation, QA status and generated artifact; file location can infer the registered project.", inputSchema: { root: z.string().optional(), application: z.string().max(100).optional(), path: z.string().max(5000).optional(), operation: z.string().max(500).optional(), status: z.string().max(500).optional(), qa: z.string().max(1000).optional(), artifact: z.string().max(5000).optional(), source: z.string().max(200).optional(), task_run_id: z.string().max(256).optional() }, annotations: navigation }, async ({ root, task_run_id, ...input }) => { try { return result(workspaceMemory.recordWorkingState(root, { ...input, taskRunId: task_run_id }, task_run_id)); } catch (e) { return failure(e); } });
    server.registerTool("context_image_memory", {
      description: "Persist and retrieve explicit image memory for the active project. Binary images are stored locally as SHA-256 content-addressed assets while searchable caption/OCR/tags and project/task/chat links stay in workspace memory. File or screen capture storage uses preview/apply confirmation; search/list/read are read-only. Images are never auto-saved merely because they were visible.",
      inputSchema: {
        action: z.enum(["preview_file","apply_file","preview_capture","apply_capture","search","read","list"]),
        root: z.string().optional(),
        path: z.string().max(5000).optional(),
        image_id: z.string().max(200).optional(),
        query: z.string().max(2000).optional(),
        caption: z.string().max(4000).optional(),
        ocr_text: z.string().max(16000).optional(),
        tags: z.array(z.string().max(120)).max(32).optional(),
        task_id: z.string().max(300).optional(),
        task_run_id: z.string().max(256).optional(),
        chat_id: z.string().max(500).optional(),
        source: z.string().max(300).optional(),
        source_id: z.string().max(1000).optional(),
        max_width: z.number().int().min(320).max(2560).optional(),
        max_height: z.number().int().min(240).max(1440).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        action_id: z.string().optional(),
        confirmation_token: z.string().optional(),
      },
      annotations: preview,
    }, async (input) => {
      try {
        const metadata = {
          caption: input.caption,
          ocrText: input.ocr_text,
          tags: input.tags,
          taskId: input.task_id,
          chatId: input.chat_id,
          source: input.source ?? "context_image_memory",
        };
        if (input.action === "list") return result(workspaceMemory.recentImages(input.root, input.limit ?? 20));
        if (input.action === "search") {
          if (!input.query) throw new Error("query is required for image-memory search.");
          return result(workspaceMemory.searchImages(input.root, input.query, input.limit ?? 12));
        }
        if (input.action === "read") {
          if (!input.image_id) throw new Error("image_id is required.");
          return resultWithImages(workspaceMemory.readImage(input.root, input.image_id));
        }
        if (input.action === "preview_file") {
          if (!input.path) throw new Error("path is required.");
          const path = files.resolvePath(input.path);
          const inspection = workspaceMemory.inspectImageSource(input.root, path);
          const pending = store.createPending("context:image_file", { root: inspection.root, path, metadata, taskRunId: input.task_run_id }, inspection.sha256);
          store.audit("context_image_preview_file", "pending", { root: inspection.root, path, sha256: inspection.sha256, actionId: pending.id });
          return result({
            actionId: pending.id,
            confirmationToken: pending.confirmationToken,
            expiresAt: pending.expiresAt,
            image: inspection,
            metadata,
            privacyNotice: "Confirm only if this image is intended to become durable project memory. Visible secrets or sensitive content inside the image will also be preserved.",
          });
        }
        if (input.action === "apply_file") {
          if (!input.action_id || !input.confirmation_token) throw new Error("action_id and confirmation_token are required.");
          const pending = store.consumePending(input.action_id, input.confirmation_token);
          if (pending.kind !== "context:image_file") throw new Error("Pending action is not an image-memory file store.");
          const payload = pending.payload as { root?: string; path?: string; metadata?: Record<string, unknown>; taskRunId?: string };
          const stored = workspaceMemory.storeImageFile(String(payload.root ?? ""), String(payload.path ?? ""), payload.metadata as any, pending.expectedHash, input.task_run_id ?? payload.taskRunId);
          store.audit("context_image_apply_file", "success", { root: stored.root, imageId: stored.id, sha256: stored.sha256 });
          return result({ stored: true, image: stored });
        }
        if (input.action === "preview_capture") {
          const context = workspaceMemory.recentImages(input.root, 1);
          const sources = (await screen.list()).sources;
          const source = input.source_id
            ? sources.find((item) => item.id === input.source_id)
            : sources.find((item) => item.kind === "screen") ?? sources[0];
          if (!source) throw new Error("Screen or window source was not found.");
          const maxWidth = input.max_width ?? 1600;
          const maxHeight = input.max_height ?? 1000;
          const pending = store.createPending("context:image_capture", { root: context.root, sourceId: source.id, sourceName: source.name, maxWidth, maxHeight, metadata, taskRunId: input.task_run_id }, null);
          store.audit("context_image_preview_capture", "pending", { root: context.root, sourceId: source.id, sourceName: source.name, actionId: pending.id });
          return result({
            actionId: pending.id,
            confirmationToken: pending.confirmationToken,
            expiresAt: pending.expiresAt,
            source,
            maxWidth,
            maxHeight,
            metadata,
            privacyNotice: "The confirmed capture will be stored as durable project image memory and may contain sensitive information visible in the selected screen or window.",
          });
        }
        if (!input.action_id || !input.confirmation_token) throw new Error("action_id and confirmation_token are required.");
        const pending = store.consumePending(input.action_id, input.confirmation_token);
        if (pending.kind !== "context:image_capture") throw new Error("Pending action is not an image-memory screen capture.");
        const payload = pending.payload as { root?: string; sourceId?: string; sourceName?: string; maxWidth?: number; maxHeight?: number; metadata?: Record<string, unknown>; taskRunId?: string };
        const capture = await screen.capture(String(payload.sourceId ?? ""), Number(payload.maxWidth ?? 1600), Number(payload.maxHeight ?? 1000));
        const stored = workspaceMemory.storeImageCapture(String(payload.root ?? ""), {
          data: capture.data,
          mimeType: capture.mimeType,
          width: capture.width,
          height: capture.height,
          sourceId: capture.source.id,
          sourceName: capture.source.name || String(payload.sourceName ?? ""),
        }, payload.metadata as any, input.task_run_id ?? payload.taskRunId);
        store.audit("context_image_apply_capture", "success", { root: stored.root, imageId: stored.id, sha256: stored.sha256, sourceId: capture.source.id });
        return resultWithImages({ stored: true, item: stored, image: { data: capture.data, mimeType: capture.mimeType, width: capture.width, height: capture.height } });
      } catch (e) { return failure(e); }
    });
  }
}
