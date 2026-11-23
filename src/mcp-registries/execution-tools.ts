import { z } from "zod";
import { observedMcpClients } from "../mcp-client-identity.js";
import { suggestToolNames } from "../tool-catalog.js";
import { VERSION } from "../version.js";
import { brainModeFile, readBrainMode, writeBrainMode, isBrainOnlyActive } from "../brain-only.js";
import type { TaskIntent } from "../router.js";
import { readOnly, preview, destructive, reversibleMutation, navigation, webRead, webNavigation, result, compactResult, failure, resultWithImages, publicTerminalSession, type ToolRegistryContext } from "./shared.js";

/** Read-only catalogue lookup uses the same registered-tool interceptor as all other tools. */
export function registerCatalogDescribeTool(server: any, source: () => Promise<any[]>, audit: (tool: string, found: boolean) => void = () => {}) {
  server.registerTool("tool_describe", {
    description: "Read full descriptions and input schemas for 1-10 registered MCP tools.",
    inputSchema: { names: z.array(z.string().min(1)).min(1).max(10) },
    annotations: readOnly,
  }, async ({ names }: { names: string[] }) => {
    const all = await source();
    const byName = new Map<string, any>(all.map((tool: any) => [tool.name, tool]));
    for (const name of names) audit(name, byName.has(name));
    const missing = names.filter((name) => !byName.has(name));
    if (missing.length) return failure(missing.map((name) =>
      `Tool "${name}" does not exist. Closest matches: ${suggestToolNames(name, [...byName.keys()]).join(", ")}`).join("\n"));
    return result({ tools: names.map((name) => {
      const tool = byName.get(name)!;
      return { name, description: tool.description, inputSchema: tool.inputSchema };
    }) });
  });
}

export function registerExecutionPlatformTools(ctx: ToolRegistryContext) {
  const { server, runtime, governor, runtimeIdentity, localAi, workstationRouter, executionPlanner, runtimeCapabilities, resultPayloadGateway } = ctx;
  const { config, store, files, terminal, office, skills, screen, projects, documents, desktop, intake, pdf, desktopIntake, browser, terminalSessions, taskRuns, workspaceMemory, video, cocCocBridge, localIntelligence, executionLanes, isolatedAgent, backgroundTurbo, healthSnapshot, planState } = runtime;
  // Shared, task-authorized mode manager. Deliberately callable even when BRAIN_ONLY
  // is active, so the Brain can switch modes without the local Dashboard or a worker.
  server.registerTool("harness_mode", {
    description: "Inspect, select, and verify the shared NHD operating mode. harness=Mode 1 Brain+worker, self=Mode 2 Brain+Harness directly (no model worker), direct=Mode 3 Brain detached from workstation. Select requires a running task, moderate task authorization and confirmed=true. The mode applies to remote/local MCP sessions through one persisted state file, but never overrides tool-specific safety gates.",
    inputSchema: {
      action: z.enum(["status", "select", "verify"]),
      mode: z.enum(["harness", "self", "direct"]).optional(),
      task_run_id: z.string().min(1).max(256).optional(),
      confirmed: z.boolean().optional(),
      verbose: z.boolean().optional(),
    },
    annotations: reversibleMutation,
  }, async (input) => {
    try {
      const file = brainModeFile();
      const status = () => {
        const mode = readBrainMode(file);
        return {
          mode,
          modeNumber: mode === "harness" ? 1 : mode === "self" ? 2 : 3,
          scope: "shared-core-runtime",
          directExecution: mode === "self",
          workerDelegation: mode === "harness",
          brainOnlyActive: isBrainOnlyActive(),
          connectionKey: ctx.connectionKey ?? null,
          saved: true,
          observedClients: observedMcpClients(),
        };
      };
      if (input.action === "status") return result(status());
      if (input.action === "verify") {
        const observed = status();
        const matches = input.mode === undefined || input.mode === observed.mode;
        return result({ ...observed, matches, verified: matches, expected: input.mode ?? null });
      }
      if (!input.mode) throw new Error("HARNESS_MODE_REQUIRED");
      if (input.confirmed !== true) throw new Error("HARNESS_MODE_CONFIRMATION_REQUIRED");
      if (!input.task_run_id) throw new Error("HARNESS_MODE_TASK_REQUIRED");
      if (config.emergencyStop) throw new Error("HARNESS_MODE_EMERGENCY_STOP");
      if (!taskRuns) throw new Error("HARNESS_MODE_TASK_RUNTIME_UNAVAILABLE");
      const task = taskRuns.get(input.task_run_id);
      if (task.state !== "running") throw new Error("HARNESS_MODE_TASK_NOT_RUNNING");
      if (!taskRuns.authorizations.allows(input.task_run_id, "moderate")) {
        throw new Error("HARNESS_MODE_TASK_AUTHORIZATION_REQUIRED");
      }
      const before = readBrainMode(file);
      if (before !== input.mode) writeBrainMode(input.mode, file);
      const after = readBrainMode(file);
      if (after !== input.mode) throw new Error("HARNESS_MODE_VERIFY_FAILED");
      store.audit("brain_mode", "mcp_select", {
        taskRunId: input.task_run_id,
        from: before,
        to: after,
        connection: ctx.connectionKey ?? null,
      });
      return result({ ...status(), changed: before !== after, verified: true });
    } catch (error) { return failure(error); }
  });

  if (executionLanes && isolatedAgent) {
    const assertAutomationEnabled = () => { if (config.emergencyStop) throw new Error("Automation is disabled by Emergency Stop."); };
    server.registerTool("execution_lanes_status", { description: "Report Background + Isolated Agent execution lanes, scheduler capacity/reservations, resource locks and artifact exchange root. Read-only; Background host foreground policy is always blocked.", inputSchema: {}, annotations: readOnly }, async () => { try { return result(executionLanes.status(isolatedAgent.status())); } catch (e) { return failure(e); } });
    server.registerTool("execution_route", { description: "Choose Background or Isolated for one task step. Background is selected for structured/non-GUI work; GUI/foreground/visual/canvas/drag-drop/native-dialog work is routed to Isolated. Planning never executes work or grants authorization.", inputSchema: { preferred:z.enum(["auto","background","isolated"]).optional(), domain:z.enum(["files","office","browser","desktop","terminal","pdf","intake","mixed"]).optional(), operation:z.string().max(100).optional(), requires_gui:z.boolean().optional(), requires_foreground:z.boolean().optional(), requires_visual:z.boolean().optional(), drag_drop:z.boolean().optional(), canvas:z.boolean().optional(), native_dialog:z.boolean().optional(), description:z.string().max(4000).optional() }, annotations: readOnly }, async (input) => { try { return result(executionLanes.plan({ preferred:input.preferred, domain:input.domain, operation:input.operation, requiresGui:input.requires_gui, requiresForeground:input.requires_foreground, requiresVisual:input.requires_visual, dragDrop:input.drag_drop, canvas:input.canvas, nativeDialog:input.native_dialog, description:input.description }, isolatedAgent.status())); } catch(e){ return failure(e); } });
    server.registerTool("execution_scheduler", { description: "Reserve/release Background or Isolated execution capacity for parallel task steps. Background concurrency is dynamic (bounded by hardware/policy) and Isolated has one slot by default. Reservations have TTL, renew idempotently, require an active durable task, require owner task_run_id on release, and never authorize workstation actions.", inputSchema:{ action:z.enum(["status","reserve","release"]), lane:z.enum(["background","isolated"]).optional(), task_run_id:z.string().max(256).optional(), step_id:z.string().max(256).optional(), reservation_id:z.string().max(256).optional(), ttl_seconds:z.number().int().min(5).max(86400).optional() }, annotations:navigation }, async (input) => { try { if(input.action==="status") return result({ reservations:executionLanes.listReservations(), status:executionLanes.status(isolatedAgent.status()).scheduler }); if(input.action==="reserve"){ assertAutomationEnabled(); if(!input.lane||!input.task_run_id) throw new Error("lane and task_run_id are required for reserve."); return result(executionLanes.reserve({lane:input.lane,taskRunId:input.task_run_id,stepId:input.step_id,ttlSeconds:input.ttl_seconds})); } if(!input.task_run_id) throw new Error("task_run_id is required for reservation release; ownerless release is forbidden."); if(!input.reservation_id) { store.requireExistingTaskRun(input.task_run_id); return result(executionLanes.releaseTaskResources(input.task_run_id,"manual_scheduler_release")); } return result(executionLanes.releaseReservation(input.reservation_id,input.task_run_id)); } catch(e){ return failure(e); } });
    server.registerTool("execution_lock", { description: "List/acquire/release task-scoped canonical resource locks across Background and Isolated lanes. Read locks may coexist; same-holder locks renew/upgrade idempotently; write/exclusive locks prevent cross-lane and cross-tool collisions. Release requires the owning task_run_id. Locks are metadata, not authorization.", inputSchema:{ action:z.enum(["list","acquire","release"]), resource:z.string().max(5000).optional(), resources:z.array(z.string().max(5000)).min(1).max(32).optional(), mode:z.enum(["read","write","exclusive"]).optional(), task_run_id:z.string().max(256).optional(), lane:z.enum(["background","isolated"]).optional(), lock_id:z.string().max(256).optional(), ttl_seconds:z.number().int().min(5).max(86400).optional() }, annotations:navigation }, async (input) => { try { if(input.action==="list") return result({locks:executionLanes.listLocks()}); if(input.action==="acquire"){ if(input.resources?.length){ if(!input.mode||!input.task_run_id||!input.lane) throw new Error("resources, mode, task_run_id and lane are required for acquire."); return result({locks:executionLanes.acquireLocks({resources:input.resources,mode:input.mode,taskRunId:input.task_run_id,lane:input.lane,ttlSeconds:input.ttl_seconds})}); } if(!input.resource||!input.mode||!input.task_run_id||!input.lane) throw new Error("resource, mode, task_run_id and lane are required for acquire."); return result(executionLanes.acquireLock({resource:input.resource,mode:input.mode,taskRunId:input.task_run_id,lane:input.lane,ttlSeconds:input.ttl_seconds})); } if(!input.task_run_id) throw new Error("task_run_id is required for lock release; ownerless release is forbidden."); if(!input.lock_id) { store.requireExistingTaskRun(input.task_run_id); return result(executionLanes.releaseTaskResources(input.task_run_id,"manual_lock_release")); } return result(executionLanes.releaseLock(input.lock_id,input.task_run_id)); } catch(e){ return failure(e); } });
    server.registerTool("execution_handoff", { description: "Create/list/get/complete/cancel an artifact handoff between Background and Isolated lanes. Each handoff gets task-scoped input/output directories under the restricted exchange root; it never copies credentials or grants authorization.", inputSchema:{ action:z.enum(["create","get","list","complete","cancel"]), task_run_id:z.string().max(256).optional(), from_lane:z.enum(["background","isolated"]).optional(), to_lane:z.enum(["background","isolated"]).optional(), handoff_id:z.string().max(256).optional() }, annotations:navigation }, async (input) => { try { if(input.action==="create"){ if(!input.task_run_id||!input.from_lane||!input.to_lane) throw new Error("task_run_id, from_lane and to_lane are required for create."); return result(executionLanes.createHandoff({taskRunId:input.task_run_id,fromLane:input.from_lane,toLane:input.to_lane})); } if(input.action==="list") return result({handoffs:executionLanes.listHandoffs(input.task_run_id)}); if(!input.handoff_id) throw new Error("handoff_id is required."); if(input.action==="get") return result(executionLanes.getHandoff(input.handoff_id)); if(input.action==="complete") return result(executionLanes.completeHandoff(input.handoff_id)); return result(executionLanes.cancelHandoff(input.handoff_id)); } catch(e){ return failure(e); } });

    server.registerTool("isolated_agent_status", { description: "Report Windows Sandbox Isolated Agent provider/configuration/heartbeat/browser state. Read-only and safe to call while the guest is offline.", inputSchema:{}, annotations:readOnly }, async()=>{ try{return result(isolatedAgent.status());}catch(e){return failure(e);} });
    server.registerTool("isolated_agent_start", { description: "Start the preconfigured Windows Sandbox Isolated Agent and wait for guest heartbeat. This never falls back to host GUI. Windows Sandbox must already be enabled; the tool does not bypass UAC or reboot Windows.", inputSchema:{ memory_mb:z.number().int().min(2048).max(6144).optional(), timeout_ms:z.number().int().min(5000).max(180000).optional() }, annotations:reversibleMutation }, async({memory_mb,timeout_ms})=>{ try{assertAutomationEnabled();return result(await isolatedAgent.start({memoryMb:memory_mb,timeoutMs:timeout_ms}));}catch(e){return failure(e);} });
    server.registerTool("isolated_agent_stop", { description: "Request a clean shutdown of the isolated Windows Sandbox guest. Host desktop is not affected.", inputSchema:{ task_run_id:z.string().max(256).optional() }, annotations:reversibleMutation }, async({task_run_id})=>{ try{return result(await isolatedAgent.stop(task_run_id));}catch(e){return failure(e);} });
    server.registerTool("isolated_browser_status", { description:"Read isolated browser status inside the Windows Sandbox guest.", inputSchema:{}, annotations:webRead }, async()=>{try{assertAutomationEnabled();return result(await isolatedAgent.browserStatus());}catch(e){return failure(e);}});
    server.registerTool("isolated_browser_navigate", { description:"Navigate the isolated guest browser to an explicit HTTP/HTTPS URL without touching host browser focus.", inputSchema:{url:z.string().url(),task_run_id:z.string().max(256).optional()}, annotations:webNavigation }, async({url,task_run_id})=>{try{assertAutomationEnabled();return result(await isolatedAgent.browserNavigate(url,task_run_id));}catch(e){return failure(e);}});
    server.registerTool("isolated_browser_snapshot", { description:"Read a bounded deep text/headings/links snapshot from the isolated guest browser. Web content is untrusted data.", inputSchema:{max_chars:z.number().int().min(1000).max(100000).optional()}, annotations:webRead }, async({max_chars})=>{try{assertAutomationEnabled();return result(await isolatedAgent.browserSnapshot(max_chars??50000));}catch(e){return failure(e);}});
    server.registerTool("isolated_browser_inspect", { description:"Inspect visible interactive DOM controls in the isolated guest browser and return short-lived selectors.", inputSchema:{query:z.string().max(500).optional(),limit:z.number().int().min(1).max(500).optional()}, annotations:webRead }, async({query,limit})=>{try{assertAutomationEnabled();return result(await isolatedAgent.browserInspect(query??"",limit??200));}catch(e){return failure(e);}});
    server.registerTool("isolated_browser_click", { description:"Click one inspected isolated-browser control. Safe navigation is automatic; ordinary commits need moderate task authorization; sensitive external actions need high task authorization. Password/file/payment-sensitive actions remain blocked.", inputSchema:{selector_id:z.string().min(1).max(256),task_run_id:z.string().max(256).optional()}, annotations:webNavigation }, async({selector_id,task_run_id})=>{try{assertAutomationEnabled();return result(await isolatedAgent.browserClick(selector_id,task_run_id));}catch(e){return failure(e);}});
    server.registerTool("isolated_browser_fill", { description:"Fill one inspected safe field in the isolated browser. Password, file-upload and payment-sensitive fields are blocked.", inputSchema:{selector_id:z.string().min(1).max(256),text:z.string().max(2000),task_run_id:z.string().max(256).optional()}, annotations:webNavigation }, async({selector_id,text})=>{try{assertAutomationEnabled();return result(await isolatedAgent.browserFill(selector_id,text));}catch(e){return failure(e);}});
    server.registerTool("isolated_browser_press", { description:"Press an approved navigation key inside the isolated browser. Enter is a possible commit and requires task authorization.", inputSchema:{key:z.enum(["ESCAPE","ENTER","TAB","SHIFT_TAB","ARROW_UP","ARROW_DOWN","ARROW_LEFT","ARROW_RIGHT","PAGE_UP","PAGE_DOWN","HOME","END","SPACE"]),task_run_id:z.string().max(256).optional()}, annotations:webNavigation }, async({key,task_run_id})=>{try{assertAutomationEnabled();return result(await isolatedAgent.browserPress(key,task_run_id));}catch(e){return failure(e);}});
    server.registerTool("isolated_browser_screenshot", { description:"Capture the isolated guest browser viewport without activating any host window/tab.", inputSchema:{}, annotations:webRead }, async()=>{try{assertAutomationEnabled();const c=await isolatedAgent.browserScreenshot() as any;return resultWithImages({page:c.page,image:{mimeType:c.mimeType,data:c.data}});}catch(e){return failure(e);}});
    server.registerTool("isolated_desktop_windows", { description:"List visible top-level windows inside the isolated Windows Sandbox desktop. Host windows are not exposed.", inputSchema:{}, annotations:readOnly }, async()=>{try{assertAutomationEnabled();return result(await isolatedAgent.desktopList());}catch(e){return failure(e);}});
    server.registerTool("isolated_desktop_inspect", { description:"Inspect Windows UI Automation controls inside one isolated guest window and return short-lived guest-only selectors.", inputSchema:{window_id:z.string().min(1).max(128),query:z.string().max(500).optional(),limit:z.number().int().min(20).max(1000).optional()}, annotations:readOnly }, async({window_id,query,limit})=>{try{assertAutomationEnabled();return result(await isolatedAgent.desktopInspect(window_id,query??"",limit??300));}catch(e){return failure(e);}});
    server.registerTool("isolated_desktop_action", { description:"Perform a task-authorized GUI action only inside the isolated guest desktop: invoke, set safe text, approved key, or visual click. It never uses host mouse/keyboard. GUI mutations require task authorization and sensitive fields remain blocked.", inputSchema:{action:z.enum(["invoke","set_text","press_key","click_point"]),window_id:z.string().max(128).optional(),selector_id:z.string().max(1024).optional(),text:z.string().max(2000).optional(),key:z.string().max(40).optional(),x_ratio:z.number().min(0).max(1).optional(),y_ratio:z.number().min(0).max(1).optional(),task_run_id:z.string().max(256).optional()}, annotations:navigation }, async(input)=>{try{assertAutomationEnabled();return result(await isolatedAgent.desktopAction({action:input.action,windowId:input.window_id,selectorId:input.selector_id,text:input.text,key:input.key,xRatio:input.x_ratio,yRatio:input.y_ratio,taskRunId:input.task_run_id}));}catch(e){return failure(e);}});
    server.registerTool("isolated_desktop_screenshot", { description:"Capture the isolated Windows Sandbox desktop only. The host desktop is not captured or activated.", inputSchema:{}, annotations:readOnly }, async()=>{try{assertAutomationEnabled();const c=await isolatedAgent.desktopScreenshot() as any;return resultWithImages({relativePath:c.relativePath,width:c.width,height:c.height,image:{mimeType:c.mimeType,data:c.data}});}catch(e){return failure(e);}});
  }

  if (backgroundTurbo) {
    const turboMicroOp = z.discriminatedUnion("kind", [
      z.object({kind:z.literal("file_stat"),path:z.string().min(1).max(5000)}),
      z.object({kind:z.literal("file_read"),path:z.string().min(1).max(5000),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxChars:z.number().int().min(1).max(200000).optional()}),
      z.object({kind:z.literal("powershell_query"),command:z.string().min(1).max(4000),cwd:z.string().max(5000).optional()}),
      z.object({kind:z.literal("python_eval"),code:z.string().min(1).max(8000)}),
      z.object({kind:z.literal("project_context"),root:z.string().max(5000).optional(),maxChars:z.number().int().min(2000).max(50000).optional(),recentLimit:z.number().int().min(1).max(20).optional()})
    ]);
    server.registerTool("background_turbo_status", {description:"Report Background Turbo persistent workers, hot-cache metrics, dynamic concurrency and zero-copy capability. Read-only.",inputSchema:{},annotations:readOnly}, async()=>{try{return result(backgroundTurbo.status())}catch(e){return failure(e)}});
    server.registerTool("background_micro_batch", {description:"Run bounded read-only/pure micro operations through warm Background workers in parallel. PowerShell is allowlisted read-only; Python is AST-sandboxed.",inputSchema:{operations:z.array(turboMicroOp).min(1).max(100),concurrency:z.number().int().min(1).max(6).optional()},annotations:readOnly}, async({operations,concurrency})=>{try{return result(await backgroundTurbo.runBatch(operations as any[],concurrency))}catch(e){return failure(e)}});
    server.registerTool("background_dag", {description:"Run a bounded dependency DAG of read-only/pure Background Turbo operations. Independent nodes execute concurrently.",inputSchema:{nodes:z.array(z.object({id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/),dependsOn:z.array(z.string()).max(20).optional(),op:turboMicroOp})).min(1).max(100),concurrency:z.number().int().min(1).max(6).optional()},annotations:readOnly}, async({nodes,concurrency})=>{try{return result(await backgroundTurbo.runDag(nodes as any[],concurrency))}catch(e){return failure(e)}});
    server.registerTool("background_artifact_handle", {description:"Create a zero-copy metadata handle for an existing approved-root file; no bytes are copied and no authorization is granted.",inputSchema:{path:z.string().min(1).max(5000)},annotations:readOnly}, async({path})=>{try{return result(backgroundTurbo.artifactHandle(path))}catch(e){return failure(e)}});
  }

  server.registerTool("tool_governor", {
    description: "Lightweight deterministic Tool Governor between ChatGPT Web and MCP. It never hides MCP capabilities, never executes workstation actions, and never grants authorization. Use action=plan once for nontrivial/uncertain tasks to get a bounded project/task memory pack, learned recipe, quality floor, soft tool budget, recommended tools and escalation triggers. action=capabilities returns a grouped summary by default; parameters.detail='full' returns the full map; action=remember_preference stores only an explicit persistent user workflow preference; action=recipe reads a learned project/task recipe; action=status reports governor metrics/cache without executing work.",
    inputSchema: {
      action: z.enum(["plan","capabilities","status","remember_preference","recipe","compile_recipe","validate_recipe","recipe_receipt"]),
      text: z.string().min(1).max(20000).optional(),
      root: z.string().max(5000).optional(),
      project_hint: z.string().max(500).optional(),
      scope: z.enum(["global","project"]).optional(),
      key: z.string().max(120).optional(),
      value: z.string().max(4000).optional(),
      source: z.string().max(500).optional(),
      task_class: z.string().max(120).optional(),
      recipe_version: z.string().max(120).optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
      preconditions: z.record(z.string(), z.boolean()).optional(),
      receipt_id: z.string().max(200).optional(),
      verbose: z.boolean().optional(),
    },
    annotations: navigation,
  }, async (input) => {
    try {
      if (input.action === "capabilities") {
        const capabilities = governor.capabilitiesResult(input.parameters);
        return input.parameters?.detail === "full" ? result(capabilities) : compactResult(capabilities);
      }
      if (input.action === "status") return result(governor.status());
      if (input.action === "plan") {
        if (!input.text) throw new Error("text is required for plan.");
        return result(governor.plan({ text: input.text, root: input.root, projectHint: input.project_hint }));
      }
      if (input.action === "remember_preference") {
        if (!input.scope || !input.key || input.value == null) throw new Error("scope, key and value are required for remember_preference.");
        return result(governor.rememberPreference({ scope: input.scope, key: input.key, value: input.value, root: input.root, source: input.source }));
      }
      if (input.action === "recipe_receipt") {
        if (!input.receipt_id) throw new Error("receipt_id is required.");
        return result(governor.recipeReceipt(input.receipt_id));
      }
      if (!input.task_class) throw new Error("task_class is required.");
      if (input.action === "compile_recipe") return result(governor.compileRecipe(input.root, input.task_class));
      if (input.action === "validate_recipe") {
        if (!input.recipe_version) throw new Error("recipe_version is required.");
        return result(governor.validateCompiledRecipe({ root:input.root, taskClass:input.task_class, recipeVersion:input.recipe_version, parameters:input.parameters, preconditions:input.preconditions }));
      }
      return result(governor.recipe(input.root, input.task_class));
    } catch (e) { return failure(e); }
  });

  server.registerTool("runtime_identity", { description: "Return one authoritative runtime/source/deployment identity view: live production version, source version, staged candidate, runtime path, source/deployment hashes, git commit when available, and rollback version/path. Read-only.", inputSchema: { verbose: z.boolean().optional() }, annotations: readOnly }, async () => result(runtimeIdentity.identity()));
  server.registerTool("workstation_health_fast", { description: "Return the latest background-collected workstation health snapshot without probing every live component on the request path. Use this for routine health checks; if deepHealthRequired=true, escalate once to workstation_health for fresh component diagnostics.", inputSchema: {}, annotations: readOnly }, async () => { try { return result(healthSnapshot?.snapshot() ?? { available:false, mode:"background-health-snapshot-v1", state:"warming", deepHealthRequired:true, deepHealthReason:"Fast Health snapshot service is unavailable." }); } catch (e) { return failure(e); } });
  server.registerTool("workstation_health", { description: "Report workstation health. Uses the full-shape background Fast Health snapshot when it is healthy/current, and automatically falls back to fresh deep component probes when the snapshot is unavailable, stale, degraded, or inconsistent with current Emergency Stop state.", inputSchema: {}, annotations: readOnly }, async () => {
    const fast=healthSnapshot?.snapshot();
    if (fast?.available && fast.deepHealthRequired === false && fast.data && (fast.data as any).emergencyStop === config.emergencyStop && String((fast.data as any).version ?? "") === VERSION) {
      const { data: _omit, ...fastMeta } = fast as any;
      return result({ ...(fast.data as Record<string,unknown>), governor:governor.status(), resultPayloadGateway: resultPayloadGateway?.status() ?? { available: false }, fastHealth:{...fastMeta,servedFromSnapshot:true} });
    }
    return result({ version: VERSION, runtimeIdentity: runtimeIdentity.identity(), root: config.roots, intakeRoots: config.intakeRoots, writeEnabled: config.writeEnabled, terminalEnabled: config.terminalEnabled, skillsEnabled: config.skillsEnabled, screenEnabled: config.screenEnabled, desktopEnabled: config.desktopEnabled, visualDesktopEnabled: config.visualDesktopEnabled, intakeEnabled: config.intakeEnabled, ocrEnabled: config.ocrEnabled, skills: skills.validate(), emergencyStop: config.emergencyStop, index: { ...store.stats(), incremental: typeof (files as any).watchStatus === "function" ? files.watchStatus() : { watching: false, roots: [], pending: 0 } }, tasks: taskRuns ? taskRuns.stats() : { available: false }, context: workspaceMemory ? workspaceMemory.stats() : { available: false }, resumeContext: workspaceMemory ? workspaceMemory.bootstrap(undefined, { maxChars: 12000, recentLimit: 5, activate: false }) : { available: false }, office: await office.status(), screen: await screen.status(), desktop: await desktop.status(), browser:browser ? await browser.status() : {enabled:false}, intake: intake.status(), pdf: await pdf.status(), cocCoc: cocCocBridge?.status() ?? { connected: false }, video: video?.status() ?? { available: false }, localAi: localAi.status(), governor: governor.status(), resultPayloadGateway: resultPayloadGateway?.status() ?? { available: false }, backgroundTurbo: backgroundTurbo?.status() ?? { available:false }, fastHealth:{...(fast ?? {available:false}),servedFromSnapshot:false,deepFallbackUsed:true} });
  });
  server.registerTool("workstation_plan", { description: "Return one canonical read-only ExecutionPlan that composes Governor advice, workstation route, Background/Isolated lane, risk/confirmation policy and adaptive QA without executing work or granting authorization. Legacy plan/capabilities fields are retained for compatibility.", inputSchema: { domain: z.enum(["auto","files","office","browser","desktop","terminal","intake","pdf"]).optional(), operation: z.enum(["read","search","inspect","navigate","edit","write","execute","capture"]), target: z.string().max(5000).optional(), application: z.enum(["word","excel","powerpoint","outlook"]).optional(), live: z.boolean().optional(), external_side_effect: z.enum(["send","upload","login","credentials","payment","transfer","purchase","call"]).optional(), allow_visual_fallback: z.boolean().optional(), description: z.string().max(20000).optional(), requires_user_session: z.boolean().optional(), browser_workload: z.enum(["auto","user-session","automation","scraping","testing"]).optional(), prefer_isolated_browser: z.boolean().optional(), text:z.string().max(20000).optional(), root:z.string().max(5000).optional(), project_hint:z.string().max(500).optional(), preferred_lane:z.enum(["auto","background","isolated"]).optional(), requires_gui:z.boolean().optional(), requires_foreground:z.boolean().optional(), requires_visual:z.boolean().optional(), drag_drop:z.boolean().optional(), canvas:z.boolean().optional(), native_dialog:z.boolean().optional(), terminal_command:z.string().max(20000).optional(), tool_name:z.string().max(200).optional(), office_operation_type:z.enum(["replace_selection","word_insert_at_cursor","word_append","word_format","word_format_paragraphs","word_replace_paragraph","word_page_setup","word_save","excel_set_range","excel_set_formula","excel_format_range","excel_save","powerpoint_replace_selected_text","powerpoint_format_selected_text","powerpoint_set_selected_shape_geometry","powerpoint_save"]).optional(), office_has_formatting:z.boolean().optional(), verbose:z.boolean().optional() }, annotations: readOnly }, async (input) => {
    try {
      const capabilities = await runtimeCapabilities();
      const intent: TaskIntent = { domain: input.domain, operation: input.operation, target: input.target, application: input.application, live: input.live, externalSideEffect: input.external_side_effect, allowVisualFallback: input.allow_visual_fallback, description: input.description, requiresUserSession: input.requires_user_session, browserWorkload: input.browser_workload, preferIsolatedBrowser: input.prefer_isolated_browser };
      const executionPlan = executionPlanner.plan({ intent, capabilities, text:input.text, root:input.root, projectHint:input.project_hint, preferredLane:input.preferred_lane, requiresGui:input.requires_gui, requiresForeground:input.requires_foreground, requiresVisual:input.requires_visual, dragDrop:input.drag_drop, canvas:input.canvas, nativeDialog:input.native_dialog, terminalCommand:input.terminal_command, toolName:input.tool_name, officeOperationType:input.office_operation_type, officeHasFormatting:input.office_has_formatting });
      return result({ executionPlan, plan: executionPlan.route, capabilities });
    } catch (e) { return failure(e); }
  });

  server.registerTool("local_ai_status", { description: "Report the NHD Direct Fast Lane + Tiny Router architecture and safety posture. No local generative model runtime or worker is attached.", inputSchema: {}, annotations: readOnly }, async () => result(localAi.status()));
  server.registerTool("local_ai_route", { description: "Classify one request into deterministic rules, semantic/context routing, the tiny classifier, direct MCP/tool work, or ChatGPT cloud escalation. Routing advice never executes tools and never invokes a local generative model.", inputSchema: { text: z.string().min(1).max(20000), operation_hint: z.string().max(200).optional(), domain_hint: z.string().max(200).optional(), external_side_effect: z.boolean().optional() }, annotations: readOnly }, async ({ text, operation_hint, domain_hint, external_side_effect }) => { try { return result(localAi.route({ text, operationHint: operation_hint, domainHint: domain_hint, externalSideEffect: external_side_effect })); } catch (e) { return failure(e); } });
  server.registerTool("local_ai_dispatch", { description: "Choose the advisory execution lane without executing anything: direct_tool preserves ChatGPT Web -> MCP -> Skill/Tool, context_gate resolves durable project/task state, and cloud handles text generation or deep/fresh reasoning. There is no local-LLM lane.", inputSchema: { text: z.string().min(1).max(20000), operation_hint: z.string().max(200).optional(), domain_hint: z.string().max(200).optional(), external_side_effect: z.boolean().optional() }, annotations: readOnly }, async ({ text, operation_hint, domain_hint, external_side_effect }) => { try { return result(localAi.dispatch({ text, operationHint: operation_hint, domainHint: domain_hint, externalSideEffect: external_side_effect })); } catch (e) { return failure(e); } });
  server.registerTool("local_ai_verify", { description: "Apply the tiny/deterministic routing confidence and verification gate. It can accept advisory routing, request re-observation, require the existing NHD policy gate, or escalate to ChatGPT cloud; it never authorizes or replays actions.", inputSchema: { tier: z.enum(["rules","semantic","tiny","direct","cloud"]), confidence: z.number().min(0).max(1), external_side_effect: z.boolean().optional(), ambiguous: z.boolean().optional(), post_condition_verified: z.boolean().optional(), evidence_count: z.number().int().min(0).max(1000).optional() }, annotations: readOnly }, async ({ tier, confidence, external_side_effect, ambiguous, post_condition_verified, evidence_count }) => { try { return result(localAi.verify({ tier, confidence, externalSideEffect: external_side_effect, ambiguous, postConditionVerified: post_condition_verified, evidenceCount: evidence_count })); } catch (e) { return failure(e); } });

}

export function registerExecutionTerminalTools(ctx: ToolRegistryContext) {
  const { server, runtime } = ctx;
  const { terminal, terminalSessions } = runtime;
server.registerTool("terminal_preview", { description: "Preview and score one PowerShell command on a 0-100 danger scale. Optional task_run_id enables a previously user-authorized high-risk scope for this task; critical commands still require the exact critical phrase. The command is not run. Read-only file inspection: use code_run instead.", inputSchema: { command: z.string().min(1).max(20000), cwd: z.string().optional(), timeout_seconds: z.number().int().min(1).max(1800).optional(), task_run_id: z.string().optional(), word_cleanup: z.boolean().optional() }, annotations: preview }, async ({ command, cwd, timeout_seconds, task_run_id, word_cleanup }) => { try { return result(terminal.preview(command, cwd, timeout_seconds, {}, task_run_id, word_cleanup !== false)); } catch (e) { return failure(e); } });
  server.registerTool("terminal_execute", { description: "Execute an exact previewed PowerShell command using its command hash and unexpired one-time transaction token. Follow preview confirmationMode: minimal/low need no extra user turn, moderate can rely on the user's explicit task request, high requires a normal explicit confirmation, and critical requires the exact confirmation phrase.", inputSchema: { action_id: z.string(), command_hash: z.string().length(64), confirmation_token: z.string(), critical_confirmation: z.string().optional() }, annotations: destructive }, async ({ action_id, command_hash, confirmation_token, critical_confirmation }) => { try { return result(await terminal.execute(action_id, command_hash, confirmation_token, critical_confirmation)); } catch (e) { return failure(e); } });
  server.registerTool("terminal_cancel", { description: "Cancel an active terminal run and its process tree.", inputSchema: { run_id: z.string() }, annotations: destructive }, async ({ run_id }) => { try { return result(terminal.cancel(run_id)); } catch (e) { return failure(e); } });

  if (terminalSessions) {
    server.registerTool("terminal_session", { description: "Manage a bounded persistent terminal context. Sessions retain only approved cwd/environment metadata and bounded verified step history; they never bypass Terminal preview/confirmation.", inputSchema: { action: z.enum(["create","list","status","set_cwd","set_environment","reset_failed","close"]), session_id: z.string().optional(), cwd: z.string().optional(), environment: z.record(z.string(), z.string().max(2000)).optional() }, annotations: navigation }, async ({ action, session_id, cwd, environment }) => {
      try {
        if (action === "create") { if (!cwd) throw new Error("cwd is required."); return result(publicTerminalSession(terminalSessions.create(cwd, environment ?? {}))); }
        if (action === "list") return result({ sessions: terminalSessions.list().map(publicTerminalSession) });
        if (!session_id) throw new Error("session_id is required.");
        if (action === "status") return result(publicTerminalSession(terminalSessions.status(session_id)));
        if (action === "set_cwd") { if (!cwd) throw new Error("cwd is required."); return result(publicTerminalSession(terminalSessions.setCwd(session_id, cwd))); }
        if (action === "set_environment") return result(publicTerminalSession(terminalSessions.setEnvironment(session_id, environment ?? {})));
        if (action === "reset_failed") return result(publicTerminalSession(terminalSessions.resetFailed(session_id)));
        return result(publicTerminalSession(terminalSessions.close(session_id)));
      } catch (e) { return failure(e); }
    });
    server.registerTool("terminal_session_preview", { description: "Preview and score one command inside a persistent terminal context on the same 0-100 danger scale. Uses the session cwd and approved environment delta, but does not execute the command.", inputSchema: { session_id: z.string(), command: z.string().min(1).max(20000), timeout_seconds: z.number().int().min(1).max(1800).optional(), word_cleanup: z.boolean().optional() }, annotations: preview }, async ({ session_id, command, timeout_seconds, word_cleanup }) => {
      try { const out = terminalSessions.preview(session_id, command, timeout_seconds, word_cleanup !== false); return result({ session: publicTerminalSession(out.session), preview: out.preview }); } catch (e) { return failure(e); }
    });
    server.registerTool("terminal_session_execute", { description: "Execute an exact command previously previewed for a persistent terminal session using the original one-time transaction token/hash. Follow the preview confirmationMode; only critical commands require the exact critical phrase. No automatic retry occurs after failure or ambiguity.", inputSchema: { session_id: z.string(), action_id: z.string(), command_hash: z.string().length(64), confirmation_token: z.string(), critical_confirmation: z.string().optional() }, annotations: destructive }, async ({ session_id, action_id, command_hash, confirmation_token, critical_confirmation }) => {
      try { const out = await terminalSessions.execute(session_id, action_id, command_hash, confirmation_token, critical_confirmation); return result({ session: publicTerminalSession(out.session), result: out.result }); } catch (e) { return failure(e); }
    });
  }
}
