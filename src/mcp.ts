import { SERVER_INSTRUCTIONS } from "./server-instructions.js";
import { ContextHandshakeService, buildContextHeader, prependText, shapeToolOutput } from "./output-shaping.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve } from "node:path";
import { FileService } from "./files.js";
import { TerminalService } from "./terminal.js";
import { OfficeService, OfficeLiveApplication, OfficeLiveOperation } from "./office.js";
import { Store } from "./db.js";
import { AppConfig } from "./config.js";
import { SkillCategory, SkillService } from "./skills.js";
import { ScreenService } from "./screen.js";
import { ProjectService, DECISION_STATUSES } from "./project.js";
import { ContentBlock, DocumentService } from "./document.js";
import { VERSION } from "./version.js";
import { DesktopService } from "./desktop.js";
import { IntakeService } from "./intake.js";
import { PdfService } from "./pdf.js";
import { DesktopIntakeWorkflow } from "./desktop-intake.js";
import { BrowserService, BrowserWaitCondition } from "./browser.js";
import { WorkstationRouter, capabilitiesFromRuntime, TaskIntent } from "./router.js";
import { TerminalSessionCoordinator } from "./terminal-session-coordinator.js";
import { TerminalSessionView } from "./terminal-session.js";
import { BrowserOrchestrator, BrowserClickCondition } from "./browser-orchestrator.js";
import { TaskRunManager, TaskRunState } from "./task-runtime.js";
import { WorkspaceContextService } from "./workspace-memory.js";
import { captureOfficeVisualReview } from "./office-live-visual.js";
import { VideoService, VideoMode } from "./video.js";
import { CocCocBridgeService } from "./coc-coc-bridge.js";
import { LocalIntelligenceService } from "./local-intelligence.js";
import { ToolGovernorService } from "./tool-governor.js";
import { ExecutionLaneService } from "./execution-lanes.js";
import { IsolatedAgentService } from "./isolated-agent.js";
import { BackgroundTurboService } from "./background-turbo.js";
import { RuntimeIdentityService } from "./runtime-identity.js";
import { HealthSnapshotService } from "./health-snapshot.js";
import { PlanStateService, type PlanState } from "./plan-state.js";
import type { WorkstationRuntime } from "./workstation-runtime.js";
import { getWorkstationToolInventory } from "./capability-registry.js";
export type { ToolInventoryItem } from "./capability-registry.js";
export { getWorkstationToolInventory };
import { registerExecutionPlatformTools, registerExecutionTerminalTools } from "./mcp-registries/execution-tools.js";
import { registerFilesTools, registerProjectDocumentTools } from "./mcp-registries/files-tools.js";
import { ProjectRagService } from "./project-rag.js";
import { registerProjectRagTools } from "./mcp-registries/project-rag-tools.js";
import { registerContextTools } from "./mcp-registries/context-tools.js";
import { registerOfficeTools } from "./mcp-registries/office-tools.js";
import { registerBrowserTools } from "./mcp-registries/browser-tools.js";
import { registerMediaTools } from "./mcp-registries/media-tools.js";
import { UnifiedExecutionPlanner } from "./execution-planner.js";
import { SelfEvolutionEngine } from "./self-evolution.js";
import { registerSelfEvolutionTools } from "./mcp-registries/self-evolution-tools.js";
import { registerDelegationTools } from "./mcp-registries/delegation-tools.js";
import { ResultPayloadGatewayService } from "./result-payload-gateway.js";
import { TOOL_FACADES, buildFacade, facadeOwnedNames, hideToolsFromList, toolFacadesEnabled, type CapturedTool } from "./tool-facades.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const preview = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const reversibleMutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const navigation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const webRead = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const webNavigation = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

function result(value: unknown) {
  return { structuredContent: value as Record<string, unknown>, content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
}

function resultWithImages(value: any) {
  const single = value?.image ? [value.image] : [];
  const many = Array.isArray(value?.images) ? value.images : [];
  const images = [...single, ...many].filter((item) => item?.data && item?.mimeType);
  const structured = { ...value } as Record<string, unknown>;
  if (value?.image) { const { data: _data, ...meta } = value.image; structured.image = meta; }
  if (Array.isArray(value?.images)) structured.images = value.images.map(({ data: _data, ...meta }: any) => meta);
  return {
    structuredContent: structured,
    content: [
      { type: "text" as const, text: JSON.stringify(structured, null, 2) },
      ...images.map((item: any) => ({ type: "image" as const, data: item.data, mimeType: item.mimeType }))
    ]
  };
}

function publicTerminalSession(session: TerminalSessionView) {
  const { env, ...rest } = session;
  return { ...rest, environmentNames: Object.keys(env).sort() };
}

// v0.24.14: bắt tay ngữ cảnh dùng chung giữa các request (server stateless).
let sharedContextHandshake: ContextHandshakeService | null = null;
export type McpRequestContext = { connectionKey?: string | null; agent?: string | null };

export function createWorkstationMcp(runtimeContext: WorkstationRuntime, requestContext: McpRequestContext = {}) {
  const {
    config, store, files, terminal, office, skills, screen, projects, documents, desktop, intake, pdf, desktopIntake,
    browser, terminalSessions, taskRuns, workspaceMemory, video, cocCocBridge, localIntelligence, executionLanes,
    isolatedAgent, backgroundTurbo, healthSnapshot, planState, governor: sharedGovernor, resultTelemetry,
    resultPayloadGateway: sharedResultPayloadGateway,
  } = runtimeContext;
  const server = new McpServer({ name: "chatgpt-workstation-bridge", version: VERSION }, {
    instructions: SERVER_INSTRUCTIONS,
  });
  const workstationRouter = new WorkstationRouter();
  const runtimeIdentity = new RuntimeIdentityService();
  const localAi = localIntelligence ?? new LocalIntelligenceService();
  const governor = sharedGovernor ?? new ToolGovernorService({
    dataDir: config.dataDir,
    workspaceMemory,
    inventoryProvider: () => getWorkstationToolInventory(server, config),
    lifecycle: "mcp-instance-fallback-v1",
  });
  const executionPlanner = new UnifiedExecutionPlanner({ router: workstationRouter, governor, executionLanes, isolatedAgent });
  const resultPayloadGateway = sharedResultPayloadGateway ?? new ResultPayloadGatewayService({
    // v0.24.9: bật mặc định; đặt NHD_RESULT_PAYLOAD_GATEWAY=0 để tắt.
    enabled: process.env.NHD_RESULT_PAYLOAD_GATEWAY !== "0",
    thresholdChars: Number(process.env.NHD_RESULT_PAYLOAD_THRESHOLD) || 16_000,
    safeTools: ["pdf_document", "context_recall", "office_read", "workstation_health_fast", "video_understand", "video_context", "document_context", "project_rag_query", "fs_list", "fs_search"],
    artifactRoot: resolve(config.projectWorkspaceRoot ?? config.roots?.[0] ?? process.cwd(), ".harness-artifacts", "result-payloads"),
  });
  const selfEvolution = config.dataDir && skills?.root ? new SelfEvolutionEngine({ dataDir: config.dataDir, skillsRoot: skills.root }) : null;
  const rawRegisterTool = server.registerTool.bind(server) as any;
  const facadesOn = toolFacadesEnabled();
  const facadeOwned = facadesOn ? facadeOwnedNames() : new Set<string>();
  const capturedTools = new Map<string, CapturedTool>();
  (server as any).registerTool = (name: string, definition: any, handler: any) => {
    const wrapped = async (...args: any[]) => {
      const started = performance.now();
      const rawInput = args[0] && typeof args[0] === "object" ? args[0] as Record<string, unknown> : null;
      const taskRunId = typeof rawInput?.task_run_id === "string" && rawInput.task_run_id.trim()
        ? rawInput.task_run_id.trim()
        : typeof rawInput?.taskRunId === "string" && rawInput.taskRunId.trim()
          ? rawInput.taskRunId.trim()
          : null;
      const lane = rawInput?.lane === "isolated" || name.startsWith("isolated_") ? "isolated" : "background";
      const invokeHandler = () => taskRunId && typeof store?.withTaskContext === "function"
        ? store.withTaskContext(taskRunId, () => handler(...args), lane)
        : handler(...args);
      const output = shapeToolOutput(name, args[0], await governor.intercept(name, args[0], definition?.annotations, invokeHandler));
      try { selfEvolution?.observeToolFailure(name, output, taskRunId); } catch { /* Metadata telemetry never breaks a work action. */ }
      const telemetryEntry = resultTelemetry?.observe(name, output, performance.now() - started, args[0]);
      const gatewayDecision = resultPayloadGateway.process(name, output, args[0], definition?.annotations);
      resultTelemetry?.recordGatewayDecision(telemetryEntry?.spanId, gatewayDecision);
      let finalOutput: unknown = gatewayDecision.output;
      const connectionKey = requestContext.connectionKey ?? null;
      const agent = requestContext.agent ?? "unknown-client";
      if (connectionKey && workspaceMemory) {
        try {
          sharedContextHandshake ??= new ContextHandshakeService((who) => buildContextHeader((workspaceMemory as any).bootstrap(undefined, { maxChars: 6000, recentLimit: 1, activate: false, mode: "progressive" }), who));
          if (name === "context_bootstrap") sharedContextHandshake.markSeen(connectionKey);
          else {
            const header = sharedContextHandshake.take(connectionKey, agent);
            if (header) { finalOutput = prependText(finalOutput, header); (workspaceMemory as any).recordAgentEvent?.(agent, "agent_connected", `${agent} connected; first tool ${name}`, { tool: name }); }
          }
          if (["context_checkpoint", "task_run_checkpoint", "task_run_step"].includes(name)) (workspaceMemory as any).recordAgentEvent?.(agent, "agent_action", `${agent}: ${name}`, { tool: name, taskRunId });
        } catch { /* Context handshake is best-effort and never breaks a tool call. */ }
      }
      return finalOutput;
    };
    capturedTools.set(name, { definition, handler: wrapped });
    // v0.24.15: tên do facade chiếm sẽ được đăng ký lại dưới dạng facade (op mặc định = tool cũ).
    if (facadeOwned.has(name)) return undefined;
    return rawRegisterTool(name, definition, wrapped);
  };
  const runtimeCapabilities = async () => {
    const [officeStatus, browserStatus, desktopStatus, pdfStatus] = await Promise.all([office.status(), browser?.status() ?? Promise.resolve({ executable: null }), desktop.status(), pdf.status()]);
    const cocCocStatus = cocCocBridge?.status() ?? { connected: false, connectedTabs: 0 };
    const isolatedStatus = isolatedAgent?.status() ?? { online: false };
    return capabilitiesFromRuntime({
      writeEnabled: config.writeEnabled, terminalEnabled: config.terminalEnabled, screenEnabled: config.screenEnabled, desktopEnabled: config.desktopEnabled, browserEnabled: config.browserEnabled, visualDesktopEnabled: config.visualDesktopEnabled, intakeEnabled: config.intakeEnabled, emergencyStop: config.emergencyStop,
      office: { companion: Boolean(officeStatus.companion), word: Boolean(officeStatus.word), excel: Boolean(officeStatus.excel), powerpoint: Boolean(officeStatus.powerpoint), outlook: Boolean(officeStatus.outlook) },
      browser: { executable: browserStatus.executable ? String(browserStatus.executable) : null, cocCocConnected: Boolean((cocCocStatus as any).connected), cocCocTabs: Number((cocCocStatus as any).connectedTabs ?? 0), isolatedBrowser: Boolean((isolatedStatus as any).online) },
      desktop: { companion: Boolean(desktopStatus.companion) },
      intake: { availableRoots: intake.status().availableRoots },
      pdf: { nativeTextExtraction: Boolean(pdfStatus.nativeTextExtraction) },
    });
  };

  const projectRag = new ProjectRagService(config, files, pdf);
  const registryContext = { server, runtime: runtimeContext, governor, runtimeIdentity, localAi, workstationRouter, executionPlanner, runtimeCapabilities, resultPayloadGateway, projectRag };
  registerExecutionPlatformTools(registryContext);
  registerFilesTools(registryContext);
  registerProjectRagTools(registryContext);
  registerExecutionTerminalTools(registryContext);
  registerContextTools(registryContext);
  registerOfficeTools(registryContext);
  registerBrowserTools(registryContext);
  registerMediaTools(registryContext);
  registerProjectDocumentTools(registryContext);
  if (runtimeContext.sbceExecutor) registerDelegationTools(registryContext, runtimeContext.sbceExecutor);
  if (selfEvolution) registerSelfEvolutionTools(registryContext, selfEvolution);

  if (facadesOn) {
    const hidden = new Set<string>();
    for (const spec of TOOL_FACADES) {
      const facade = buildFacade(spec, capturedTools);
      if (!facade) {
        // Too few members present: restore a captured owned name as a plain tool.
        const own = capturedTools.get(spec.name);
        if (facadeOwned.has(spec.name) && own) rawRegisterTool(spec.name, own.definition, own.handler);
        continue;
      }
      rawRegisterTool(facade.name, facade.definition, facade.handler);
      for (const op of facade.ops) if (spec.members[op] !== spec.name) hidden.add(spec.members[op]);
    }
    hideToolsFromList(server, hidden);
    (server as any)._nhdHiddenTools = hidden;
  }

  return server;
}

