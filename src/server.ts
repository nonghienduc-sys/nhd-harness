import express, { Request, Response, NextFunction } from "express";
import { writeFileSync } from "node:fs";
import { defaultConfiguredRoots } from "./config.js";
import { listFixedDrives, validateRoots } from "./roots-config.js";
import { setConfiguredRoots } from "./resource-guard.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolve } from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import { Store } from "./db.js";
import { FileService } from "./files.js";
import { TerminalService } from "./terminal.js";
import { OfficeService } from "./office.js";
import { TunnelSupervisorClient } from "./tunnel-client.js";
import { OpenAISecureTunnelService } from "./openai-secure-tunnel.js";
import { FirstRunCloudflare, cloudflareSetupPlan } from "./setup-wizard.js";
import { createOAuthRouter, validateBearer } from "./oauth.js";
import { createWorkstationMcp, getWorkstationToolInventory } from "./mcp.js";
import { rememberMcpClient, resolveMcpClientIdentityKey } from "./mcp-client-identity.js";
import { SkillService } from "./skills.js";
import { ScreenService } from "./screen.js";
import { ProjectService } from "./project.js";
import { DocumentService } from "./document.js";
import { VERSION } from "./version.js";
import { DesktopService } from "./desktop.js";
import { IntakeService } from "./intake.js";
import { PdfService } from "./pdf.js";
import { DesktopIntakeWorkflow } from "./desktop-intake.js";
import { BrowserService } from "./browser.js";
import { TerminalSessionManager } from "./terminal-session.js";
import { TerminalSessionCoordinator } from "./terminal-session-coordinator.js";
import { TaskRunManager } from "./task-runtime.js";
import { WorkspaceContextService } from "./workspace-memory.js";
import { ChatHealthService } from "./chat-health.js";
import { ResponseSpeedStore } from "./response-speed-benchmark.js";
import { VideoService } from "./video.js";
import { CocCocBridgeService } from "./coc-coc-bridge.js";
import { LocalIntelligenceService } from "./local-intelligence.js";
import { ToolGovernorService } from "./tool-governor.js";
import { ExecutionLaneService } from "./execution-lanes.js";
import { IsolatedAgentService } from "./isolated-agent.js";
import { RuntimeIdentityService } from "./runtime-identity.js";
import { RuntimeLifecycleService } from "./runtime-lifecycle.js";
import { BackgroundTurboService } from "./background-turbo.js";
import { HealthSnapshotService } from "./health-snapshot.js";
import { PlanStateService } from "./plan-state.js";
import { HarnessConnectionService, type HarnessTransport } from "./harness-connections.js";
import { createWorkstationRuntime } from "./workstation-runtime.js";
import { inspectCodexMcpConfig } from "./mcp-client-guard.js";
import { ResultTelemetryService } from "./result-telemetry.js";
import { ResultPayloadGatewayService } from "./result-payload-gateway.js";
import { SbceProcess, resolveSbceMode } from "./sbce-process.js";
import { ProjectRagService } from "./project-rag.js";
import { ProjectRagWatcher, ragWatchStatePath } from "./project-rag-watch.js";
import { brainModeFile, isBrainOnlyTransport, readBrainMode, writeBrainMode } from "./brain-only.js";

const config = loadConfig();
const store = new Store();
const files = new FileService(config, store);
const taskRuns = new TaskRunManager(store, { roots: config.roots });
const sbceModeResolved = resolveSbceMode(process.env.NHD_SBCE_MODE, config.dataDir);
const sbceExecutor = new SbceProcess(config.dataDir, sbceModeResolved.mode);
const plans = new PlanStateService(store, taskRuns);
taskRuns.setCompletionGuard((taskRunId) => plans.taskCompletionGuard(taskRunId));
const terminal = new TerminalService(config, store, files, {}, taskRuns.authorizations);
const terminalSessionManager = new TerminalSessionManager({ roots: config.roots, maxSessions: 4, ttlMs: 30 * 60_000, maxHistory: 50, requireExistingCwd: true });
const terminalSessions = new TerminalSessionCoordinator(terminalSessionManager, terminal);
if (config.emergencyStop) terminalSessions.emergencyStop();
if (config.emergencyStop) taskRuns.pauseForEmergencyStop("Emergency Stop was active when the workstation runtime started.");
const office = new OfficeService(config, store, files);
const tunnel = new TunnelSupervisorClient(config, store);
const openAiTunnel = new OpenAISecureTunnelService(config, store);
const firstRunCloudflare = new FirstRunCloudflare(config, () => saveConfig(config));
const skills = new SkillService(config);
const screen = new ScreenService(config, store);
const projects = new ProjectService(config, store, files);
const workspaceMemory = new WorkspaceContextService(config, projects, taskRuns, { planState: plans });
const governor = new ToolGovernorService({
  dataDir: config.dataDir,
  workspaceMemory,
  inventoryProvider: () => [],
  lifecycle: "runtime-scoped-v1",
});
const backgroundTurbo = new BackgroundTurboService(store, files, workspaceMemory);
terminal.attachBackgroundTurbo(backgroundTurbo);
void backgroundTurbo.prewarm().catch((error) => console.error("Background Turbo prewarm failed:", error));
const chatHealth = new ChatHealthService({ dataDir: config.dataDir });
const responseSpeed = new ResponseSpeedStore(resolve(config.projectWorkspaceRoot, "Model Benchmark MCP", "ChatGPT Plus UI"));
const cocCocBridge = new CocCocBridgeService(store, taskRuns.authorizations);
const localIntelligence = new LocalIntelligenceService();
const executionLanes = new ExecutionLaneService(store);
const isolatedAgent = new IsolatedAgentService(store, taskRuns.authorizations, executionLanes.exchangeRoot);
const runtimeIdentity = new RuntimeIdentityService();
const runtimeLifecycle = new RuntimeLifecycleService(config.dataDir, VERSION);
const harnessConnections = new HarnessConnectionService(config.localHarnessPort, config.localHarnessEnabled);
const resultTelemetry = new ResultTelemetryService();
const resultPayloadGateway = new ResultPayloadGatewayService({
  // v0.24.10: bật mặc định ở tiến trình chính (trước đây chỉ bật trong mcp.ts fallback); NHD_RESULT_PAYLOAD_GATEWAY=0 để tắt.
  enabled: process.env.NHD_RESULT_PAYLOAD_GATEWAY !== "0",
  thresholdChars: Number(process.env.NHD_RESULT_PAYLOAD_THRESHOLD) || 16_000,
  safeTools: ["pdf_document", "context_recall", "office_read", "workstation_health_fast", "video_understand", "video_context", "document_context", "project_rag_query", "fs_list", "fs_search"],
  artifactRoot: resolve(config.projectWorkspaceRoot ?? config.roots?.[0] ?? process.cwd(), ".harness-artifacts", "result-payloads"),
});
// Fast Health is an always-on hot path. Cache deterministic filesystem-heavy metadata here;
// authoritative/deep health still recomputes it on demand.
let fastSkillValidation = skills.validate();
const fastRuntimeIdentity = runtimeIdentity.identity();
const chatHealthStreams = new Set<Response>();

function broadcastChatHealth(result: unknown = null) {
  const data = JSON.stringify({
    type: "telemetry",
    tab: result,
    overview: chatHealth.listTabs(false).overview,
    settings: chatHealth.settings(),
    at: new Date().toISOString()
  });
  for (const stream of [...chatHealthStreams]) {
    try { stream.write(`event: telemetry\ndata: ${data}\n\n`); }
    catch { chatHealthStreams.delete(stream); }
  }
}
const documents = new DocumentService(config, store, files, projects, office);
const desktop = new DesktopService(config, store, taskRuns.authorizations);
const browser = new BrowserService(config, store);
const intake = new IntakeService(config, store);
const pdf = new PdfService(config, store, files, intake);
const video = new VideoService(config, store);
// 0.24.33: owner-enabled auto-sync of project RAG stores (one shared watcher for all MCP sessions).
const projectRagWatch = new ProjectRagWatcher(new ProjectRagService(config, files, pdf), { statePath: ragWatchStatePath(config.dataDir), store, gate: () => ({ emergencyStop: config.emergencyStop, writeEnabled: config.writeEnabled }) });
try { projectRagWatch.restore(); } catch (error) { console.error("RAG auto-sync restore failed:", error); }
const desktopIntake = new DesktopIntakeWorkflow(config, store, desktop, intake, pdf);
const healthSnapshot = new HealthSnapshotService(async () => {
  const [officeStatus, screenStatus, desktopStatus, browserStatus, pdfStatus] = await Promise.all([office.status(), screen.status(), desktop.status(), browser.status(), pdf.status()]);
  const isolatedStatus = isolatedAgent.status();
  const tunnelStatus = tunnel.status();
  const openAiTunnelStatus = openAiTunnel.status();
  const connectionStatus = harnessConnections.status();
  const clientMcpGuard = inspectCodexMcpConfig({ knownEndpoints:[connectionStatus.localIngress.mcpUrl, tunnelStatus.mcpUrl, openAiTunnelStatus.targetUrl] });
  return {
    service:"ChatGPT Workstation MCP Bridge", version:VERSION, runtimeIdentity:fastRuntimeIdentity, runtime:runtimeLifecycle.status(), instanceId:config.instanceId, root:config.roots, intakeRoots:config.intakeRoots, port:config.port,
    writeEnabled:config.writeEnabled, terminalEnabled:config.terminalEnabled, skillsEnabled:config.skillsEnabled, screenEnabled:config.screenEnabled, desktopEnabled:config.desktopEnabled, visualDesktopEnabled:config.visualDesktopEnabled, intakeEnabled:config.intakeEnabled, ocrEnabled:config.ocrEnabled, emergencyStop:config.emergencyStop,
    skills:fastSkillValidation, index:{...store.stats(),incremental:files.watchStatus()}, tasks:taskRuns.stats(), plans:plans.stats(), context:workspaceMemory.stats(),
    resumeContext:{ available:true, deferred:true, source:"fast-health", reason:"Fast Health never performs context_bootstrap on the HTTP event loop; use context_bootstrap for authoritative resume context." },
    tunnel:tunnel.status(), openAiTunnel:openAiTunnel.status(), office:officeStatus, screen:screenStatus, desktop:desktopStatus, browser:browserStatus, cocCoc:cocCocBridge.status(), intake:intake.status(), pdf:pdfStatus, video:video.status(),
    localAi:localIntelligence.status(), executionLanes:executionLanes.status(isolatedStatus), isolatedAgent:isolatedStatus, backgroundTurbo:backgroundTurbo.status(), governor:governor.status(), resultTelemetry:resultTelemetry.status(), resultPayloadGateway:resultPayloadGateway.status(), connections:connectionStatus, clientMcpGuard,
  };
}, { refreshIntervalMs:15_000, staleAfterMs:45_000, isDegraded:(data:any) => {
  if (data?.skills && Number(data.skills.valid) !== Number(data.skills.total)) return "Skill validation is degraded.";
  if (data?.context?.bindingModel && data.context.bindingModel !== "conversation-project-task") return "Context binding model is unexpected.";
  if (data?.localAi?.modelInvocationEnabled !== false || data?.localAi?.localModelRuntime !== "disabled") return "Local-AI safety/runtime contract is unexpected.";
  const turbo=data?.backgroundTurbo; if (!turbo?.available || !turbo?.workers?.python?.online || !Array.isArray(turbo?.workers?.powershell) || turbo.workers.powershell.some((w:any)=>!w.online)) return "Background Turbo worker is offline.";
  if (!data?.pdf?.nativeTextExtraction || !data?.pdf?.performance?.worker?.online) return "PDF persistent worker is offline.";
  return null;
} });
healthSnapshot.start();
const workstationRuntime = createWorkstationRuntime({
  config, store, files, terminal, office, skills, screen, projects, documents, desktop, intake, pdf, desktopIntake,
  browser, terminalSessions, taskRuns, workspaceMemory, video, cocCocBridge, localIntelligence, executionLanes,
  isolatedAgent, backgroundTurbo, healthSnapshot, planState: plans, governor, harnessConnections, resultTelemetry, resultPayloadGateway, sbceExecutor, projectRagWatch,
});
const dashboardMcp = createWorkstationMcp(workstationRuntime);
governor.setInventoryProvider(() => getWorkstationToolInventory(dashboardMcp, config));
const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "6mb" }));

const isLocalHost = (request: Request) => /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(request.headers.host ?? "");
const publicBase = () => tunnel.status().url ?? `http://${config.host}:${config.port}`;

app.get("/.well-known/oauth-authorization-server", (_request, response) => response.json({ issuer: publicBase(), authorization_endpoint: `${publicBase()}/oauth/authorize`, token_endpoint: `${publicBase()}/oauth/token`, registration_endpoint: `${publicBase()}/oauth/register`, revocation_endpoint: `${publicBase()}/oauth/revoke`, code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: ["mcp", "offline_access"], token_endpoint_auth_methods_supported: ["none"] }));
app.get("/.well-known/oauth-protected-resource", (_request, response) => response.json({ resource: `${publicBase()}/mcp`, authorization_servers: [publicBase()], bearer_methods_supported: ["header"] }));
app.use("/oauth", createOAuthRouter(config, store, publicBase));

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

async function handleMcpRequest(request: Request, response: Response, transportKind: HarnessTransport, authenticatedBearer = false) {
  if (request.method !== "POST") return response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  harnessConnections.observe({ transport: transportKind, harnessId: headerValue(request.headers["x-nhd-harness-id"]), connectionId: headerValue(request.headers["x-nhd-connection-id"]), userAgent: headerValue(request.headers["user-agent"]) });
  const harnessIdHeader = headerValue(request.headers["x-nhd-harness-id"]);
  const connectionIdHeader = headerValue(request.headers["x-nhd-connection-id"]);
  const userAgentHeader = headerValue(request.headers["user-agent"]);
  const connectionKey = [transportKind, harnessIdHeader ?? "", connectionIdHeader ?? "", userAgentHeader ?? ""].join("|");
  const clientIdentityKey = resolveMcpClientIdentityKey({
    sessionId: headerValue(request.headers["mcp-session-id"]),
    authorization: headerValue(request.headers.authorization),
    authenticatedBearer,
    connectionKey: connectionIdHeader || harnessIdHeader ? connectionKey : null,
  });
  if (clientIdentityKey && request.body?.method === "initialize") rememberMcpClient(clientIdentityKey, request.body?.params?.clientInfo);
  const server = createWorkstationMcp(workstationRuntime, {
    connectionKey,
    clientIdentityKey,
    agent: (harnessIdHeader || userAgentHeader || transportKind).slice(0, 80),
    brainOnly: isBrainOnlyTransport(transportKind),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => { void transport.close(); void server.close(); });
  } catch (error) {
    store.audit("mcp", "error", { transport: transportKind, error: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
}

app.all("/mcp", async (request, response) => {
  if (!validateBearer(store, request.headers.authorization)) {
    response.setHeader("WWW-Authenticate", `Bearer resource_metadata=\"${publicBase()}/.well-known/oauth-protected-resource\"`);
    return response.status(401).json({ error: "unauthorized" });
  }
  return handleMcpRequest(request, response, "remote-http", true);
});

const localMcpApp = express();
localMcpApp.disable("x-powered-by");
localMcpApp.use(express.json({ limit: "6mb" }));
localMcpApp.get("/health", (_request, response) => response.json({ ok:true, service:"NHD MCP Local Harness", version:VERSION, instanceId:config.instanceId, corePort:config.port, localHarnessPort:config.localHarnessPort, model:"multi-harness-single-core-v1" }));
localMcpApp.all("/mcp", (request, response) => {
  const explicitTransport=headerValue(request.headers["x-nhd-transport"]);
  const userAgent=(headerValue(request.headers["user-agent"])||"").toLowerCase();
  const kind:HarnessTransport=explicitTransport==="stdio-proxy"?"stdio-proxy":userAgent.includes("tunnel-client")?"openai-secure-tunnel":"local-http";
  return handleMcpRequest(request,response,kind);
});

function localOnly(request: Request, response: Response, next: NextFunction) {
  if (!isLocalHost(request)) return response.status(404).end();
  next();
}
app.use("/api", localOnly);

// Root changes are owner-only via localhost dashboard; no MCP tool exists for this.
app.get("/api/roots", (_request, response) => {
  response.json({ roots: config.roots, drives: listFixedDrives(), defaults: defaultConfiguredRoots() });
});
app.put("/api/roots", (request, response) => {
  const origin = request.headers.origin;
  if (origin && !["http://127.0.0.1:" + config.port, "http://localhost:" + config.port].includes(origin))
    return response.status(403).json({ error: "Từ chối: Origin không phải dashboard trên máy này." });
  if (!request.is("application/json"))
    return response.status(415).json({ error: "Yêu cầu Content-Type: application/json." });
  try {
    const next = validateRoots(request.body?.roots);
    // Persist before changing live shared state; splice preserves references captured by services.
    saveConfig({ ...config, roots: next });
    config.roots.splice(0, config.roots.length, ...next);
    setConfiguredRoots(config.roots);
    files.refreshRootsWatchers();
    store.audit("config", "roots_updated", { count: config.roots.length, roots: config.roots });
    return response.json({ ok: true, roots: config.roots });
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// The mode selector is independent from the SBCE worker: Mode 2 must work even when
// the worker is unavailable or disabled. This endpoint remains localhost-only.
function brainModeApiGuard(request: Request, response: Response): boolean {
  const origin = request.headers.origin;
  if (origin && !["http://127.0.0.1:" + config.port, "http://localhost:" + config.port].includes(origin)) {
    response.status(403).json({ error: "BRAIN_MODE_ORIGIN_DENIED" });
    return false;
  }
  return true;
}
app.get("/api/brain-mode", async (request, response) => {
  if (!brainModeApiGuard(request, response)) return;
  const file = brainModeFile(process.env);
  response.json({
    mode: readBrainMode(file),
    modeNumber: readBrainMode(file) === "harness" ? 1 : readBrainMode(file) === "self" ? 2 : 3,
    scope: "shared-core-runtime",
    file,
    override: process.env.NHD_BRAIN_ONLY === "0",
  });
});

app.post("/api/brain-mode", async (request, response) => {
  if (!brainModeApiGuard(request, response)) return;
  if (request.body?.confirmed !== true) return response.status(400).json({ error: "BRAIN_MODE_CONFIRMATION_REQUIRED" });
  const mode = request.body?.mode;
  if (mode !== "harness" && mode !== "self" && mode !== "direct") {
    return response.status(400).json({ error: "BRAIN_MODE_INVALID" });
  }
  try {
    const before = readBrainMode(brainModeFile(process.env));
    const result = writeBrainMode(mode, brainModeFile(process.env));
    const verified = readBrainMode(brainModeFile(process.env)) === mode;
    if (!verified) throw new Error("BRAIN_MODE_VERIFY_FAILED");
    store.audit("brain_mode", "dashboard_set", { before, mode, verified });
    response.json({ ...result, verified, scope: "shared-core-runtime" });
  } catch {
    response.status(500).json({ error: "BRAIN_MODE_WRITE_FAILED" });
  }
});
app.get("/api/sbce/status", async (_request,response) => response.json({...await sbceExecutor.status(), modeSource:sbceModeResolved.source}));
function sbceLocalGuard(request: Request, response: Response): boolean {
  const origin=request.headers.origin;
  if(origin && !["http://127.0.0.1:"+config.port,"http://localhost:"+config.port].includes(origin)){response.status(403).json({error:"SBCE_ORIGIN_DENIED"});return false;}
  if(config.emergencyStop){response.status(409).json({error:"SBCE_EMERGENCY_STOP"});return false;}
  if(sbceExecutor.mode==="off"){response.status(409).json({error:"SBCE_DISABLED"});return false;}
  return true;
}
// P1 calibration (local-only): list models the key can use; one fixed tiny probe call per request.
app.get("/api/sbce/models", async(request,response) => {
  if(!sbceLocalGuard(request,response))return;
  try { response.json(await sbceExecutor.request("GET","/admin/models",undefined,20000)); }
  catch(error) { response.status(503).json({error:error instanceof Error?error.message:"SBCE_MODELS_FAILED"}); }
});
app.post("/api/sbce/probe", async(request,response) => {
  if(!sbceLocalGuard(request,response))return;
  const catalogId=String(request.body?.catalog_id??"");
  if(!/^[a-zA-Z0-9_.-]{2,100}$/.test(catalogId))return response.status(400).json({error:"SBCE_PROBE_ID_INVALID"});
  try { response.json(await sbceExecutor.request("POST","/admin/probe",{catalog_id:catalogId},27000)); }
  catch(error) { response.status(503).json({error:error instanceof Error?error.message:"SBCE_PROBE_FAILED"}); }
});
// 0.24.29 SBCE board: jobs, cost, writer/judge models, checks, draft preview, owner review.
function sbceReadGuard(request: Request, response: Response): boolean {
  const origin=request.headers.origin;
  if(origin && !["http://127.0.0.1:"+config.port,"http://localhost:"+config.port].includes(origin)){response.status(403).json({error:"SBCE_ORIGIN_DENIED"});return false;}
  if(sbceExecutor.mode==="off"){response.status(409).json({error:"SBCE_DISABLED"});return false;}
  return true;
}
const SBCE_JOB_ID=/^job-[a-f0-9-]{8,64}$/;
app.get("/api/sbce/admin", async(request,response) => {
  if(!sbceReadGuard(request,response))return;
  try { response.json(await sbceExecutor.request("GET","/admin",undefined,8000)); }
  catch(error) { response.status(503).json({error:error instanceof Error?error.message:"SBCE_ADMIN_FAILED"}); }
});
// 0.24.34 model benchmark (local owner only). Spends real HHTECH credit, capped by budget_vnd (default 15000, max 30000).
app.post("/api/sbce/bench/start", async(request,response) => {
  if(!sbceLocalGuard(request,response))return;
  const body=request.body??{};
  const payload={model_ids:body.model_ids,task_ids:body.task_ids,runs:body.runs,budget_vnd:body.budget_vnd,concurrency:body.concurrency};
  try { const result=await sbceExecutor.request("POST","/admin/bench/start",payload,20000); store.audit("sbce","bench_start",{runId:result?.run_id,planned:result?.planned_calls,budgetVnd:payload.budget_vnd??15000}); response.json(result); }
  catch(error) { response.status(409).json({error:error instanceof Error?error.message:"SBCE_BENCH_FAILED"}); }
});
app.get("/api/sbce/bench/status", async(request,response) => {
  if(!sbceReadGuard(request,response))return;
  const runId=request.query.run_id===undefined?undefined:String(request.query.run_id);
  if(runId!==undefined&&!/^bench-[0-9TZ-]{10,40}$/.test(runId))return response.status(400).json({error:"SBCE_BENCH_RUN_ID_INVALID"});
  try { response.json(await sbceExecutor.request("POST","/admin/bench/status",runId?{run_id:runId}:{},8000)); }
  catch(error) { response.status(503).json({error:error instanceof Error?error.message:"SBCE_BENCH_STATUS_FAILED"}); }
});
app.get("/api/sbce/bench/list", async(request,response) => {
  if(!sbceReadGuard(request,response))return;
  try { response.json(await sbceExecutor.request("POST","/admin/bench/list",{},8000)); }
  catch(error) { response.status(503).json({error:error instanceof Error?error.message:"SBCE_BENCH_LIST_FAILED"}); }
});
// Checklist board: name each job's owning task run (one MCP chat/task) so parallel chats can be told apart.
function sbceTaskLookup(jobs:unknown):Record<string,{objective:string;root:string|null;state:string;updatedAt:string}>{
  const ids=[...new Set((Array.isArray(jobs)?jobs:[]).map((j:any)=>String(j?.owner??"")).filter(id=>id&&id.length<=256))].slice(0,100);
  const out:Record<string,{objective:string;root:string|null;state:string;updatedAt:string}>={};
  if(!ids.length)return out;
  try{
    const query=store.db.prepare("SELECT id,objective,root,state,updated_at FROM agent_runs WHERE id=?");
    for(const id of ids){const row=query.get(id) as any;if(row)out[id]={objective:String(row.objective??"").slice(0,300),root:row.root??null,state:String(row.state??""),updatedAt:String(row.updated_at??"")};}
  }catch{}
  return out;
}
app.get("/api/sbce/jobs", async(request,response) => {
  if(!sbceReadGuard(request,response))return;
  const limit=Math.max(1,Math.min(Number(request.query.limit??50)||50,100));
  try { const board=await sbceExecutor.request("GET","/admin/jobs?limit="+limit,undefined,8000); response.json({...board,tasks:sbceTaskLookup(board?.jobs)}); }
  catch(error) { response.status(503).json({error:error instanceof Error?error.message:"SBCE_JOBS_FAILED"}); }
});
app.get("/api/sbce/jobs/:id", async(request,response) => {
  if(!sbceReadGuard(request,response))return;
  const id=String(request.params.id);
  if(!SBCE_JOB_ID.test(id))return response.status(400).json({error:"SBCE_JOB_ID_INVALID"});
  try { response.json(await sbceExecutor.request("GET","/admin/jobs/"+id,undefined,8000)); }
  catch(error) { response.status(409).json({error:error instanceof Error?error.message:"SBCE_JOB_FAILED"}); }
});
app.post("/api/sbce/jobs/:id/review", async(request,response) => {
  if(!sbceLocalGuard(request,response))return;
  const id=String(request.params.id);
  if(!SBCE_JOB_ID.test(id))return response.status(400).json({error:"SBCE_JOB_ID_INVALID"});
  if(request.body?.confirmed!==true)return response.status(400).json({error:"Owner confirmation required."});
  const decision=String(request.body?.decision??"");
  if(decision!=="accept"&&decision!=="reject")return response.status(400).json({error:"SBCE_DECISION_INVALID"});
  const note=String(request.body?.note??"").slice(0,1000);
  try {
    const result=await sbceExecutor.request("POST","/admin/jobs/"+id+"/review",{decision,note},8000);
    store.audit("sbce","dashboard_review",{jobId:id,decision,status:result?.status});
    response.json(result);
  } catch(error) { response.status(409).json({error:error instanceof Error?error.message:"SBCE_REVIEW_FAILED"}); }
});
app.post("/api/sbce/secret", async(request,response) => {
  const origin=request.headers.origin;
  if(origin && !["http://127.0.0.1:"+config.port,"http://localhost:"+config.port].includes(origin))return response.status(403).json({error:"SBCE_ORIGIN_DENIED"});
  if(config.emergencyStop)return response.status(409).json({error:"SBCE_EMERGENCY_STOP"});
  if(sbceExecutor.mode==="off")return response.status(409).json({error:"SBCE_DISABLED"});
  const key=String(request.body?.key??"");
  if(key.length<12||key.length>300)return response.status(400).json({error:"SBCE_INVALID_KEY"});
  try { const saved=await sbceExecutor.request("POST","/session-key",{key});response.json(saved); }
  catch(error) { response.status(503).json({error:error instanceof Error?error.message:"SBCE_VAULT_WRITE_FAILED"}); }
});
app.get("/api/health/live", (_request, response) => response.json({ ok:true, service:"ChatGPT Workstation MCP Bridge", version:VERSION, instanceId:config.instanceId, port:config.port, runtime:runtimeLifecycle.status(), at:new Date().toISOString() }));
app.get("/api/health/fast", (_request, response) => response.json(healthSnapshot.snapshot()));
app.get("/api/harnesses", (_request, response) => response.json(harnessConnections.status()));
app.post("/api/health/fast/refresh", async (_request, response) => { try { response.json(await healthSnapshot.refresh()); } catch(error){ response.status(503).json({ error:error instanceof Error ? error.message : String(error), snapshot:healthSnapshot.snapshot() }); } });
app.get("/api/health", async (_request, response) => {
  const [officeStatus, screenStatus, desktopStatus, browserStatus, pdfStatus] = await Promise.all([
    office.status(),
    screen.status(),
    desktop.status(),
    browser.status(),
    pdf.status(),
  ]);
  response.json({
    service: "ChatGPT Workstation MCP Bridge",
    version: VERSION,
    runtimeIdentity: runtimeIdentity.identity(),
    runtime: runtimeLifecycle.status(),
    instanceId: config.instanceId,
    root: config.roots,
    intakeRoots: config.intakeRoots,
    port: config.port,
    writeEnabled: config.writeEnabled,
    terminalEnabled: config.terminalEnabled,
    skillsEnabled: config.skillsEnabled,
    screenEnabled: config.screenEnabled,
    desktopEnabled: config.desktopEnabled,
    browserEnabled: config.browserEnabled,
    visualDesktopEnabled: config.visualDesktopEnabled,
    intakeEnabled: config.intakeEnabled,
    ocrEnabled: config.ocrEnabled,
    skills: skills.validate(),
    emergencyStop: config.emergencyStop,
    index: { ...store.stats(), incremental: files.watchStatus() },
    tasks: taskRuns.stats(),
    plans: plans.stats(),
    context: workspaceMemory.stats(),
    tunnel: tunnel.status(),
    openAiTunnel: openAiTunnel.status(),
    office: officeStatus,
    screen: screenStatus,
    desktop: desktopStatus,
    browser: browserStatus,
    cocCoc: cocCocBridge.status(),
    intake: intake.status(),
    pdf: pdfStatus,
    video: video.status(),
    localAi: localIntelligence.status(),
    executionLanes: executionLanes.status(isolatedAgent.status()),
    isolatedAgent: isolatedAgent.status(),
    backgroundTurbo: backgroundTurbo.status(),
    governor: governor.status(),
    resultTelemetry: resultTelemetry.status(),
    resultPayloadGateway: resultPayloadGateway.status(),
    connections: harnessConnections.status(),
    clientMcpGuard: inspectCodexMcpConfig({ knownEndpoints:[harnessConnections.status().localIngress.mcpUrl, tunnel.status().mcpUrl, openAiTunnel.status().targetUrl] }),
  });
});
app.get("/api/execution-lanes/status", (_request, response) => response.json(executionLanes.status(isolatedAgent.status())));
app.get("/api/background-turbo/status", (_request, response) => response.json(backgroundTurbo.status()));
app.get("/api/isolated-agent/status", (_request, response) => response.json(isolatedAgent.status()));
app.post("/api/isolated-agent/start", async (request, response) => { try { if (config.emergencyStop) return response.status(409).json({ error:"Emergency Stop is active." }); response.json(await isolatedAgent.start({ memoryMb: request.body?.memoryMb, timeoutMs: request.body?.timeoutMs })); } catch(error){ response.status(409).json({ error:error instanceof Error ? error.message : String(error) }); } });
app.post("/api/isolated-agent/stop", async (_request, response) => { try { response.json(await isolatedAgent.stop()); } catch(error){ response.status(409).json({ error:error instanceof Error ? error.message : String(error) }); } });
app.get("/api/coc-coc-bridge/status", (_request, response) => response.json(cocCocBridge.status()));
app.get("/api/coc-coc-bridge/tabs", (_request, response) => response.json({ tabs: cocCocBridge.listTabs() }));
app.post("/api/coc-coc-bridge/pulse", (request, response) => {
  try { response.json(cocCocBridge.pulse((request.body ?? {}) as Record<string, unknown>)); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/coc-coc-bridge/result", (request, response) => {
  try { response.json(cocCocBridge.resolveResult((request.body ?? {}) as Record<string, unknown>)); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/coc-coc-bridge/tab-closed", (request, response) => {
  try { response.json(cocCocBridge.closeTab(request.body?.tabId)); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/chat-health/sensor-smoke/open", async (request, response) => {
  try { response.json(await cocCocBridge.openChatHealthSmoke(String(request.body?.url ?? "https://chatgpt.com/"))); }
  catch(error){ response.status(400).json({error:error instanceof Error ? error.message : String(error)}); }
});
app.post("/api/chat-health/sensor-smoke/close", async (request, response) => {
  try { response.json(await cocCocBridge.closeChatHealthSmoke(Number(request.body?.tabId))); }
  catch(error){ response.status(400).json({error:error instanceof Error ? error.message : String(error)}); }
});
app.get("/api/chat-health", (_request, response) => response.json(chatHealth.status()));
app.get("/api/chat-health/tabs", (request, response) => {
  try { response.json(chatHealth.listTabs(String(request.query.includeArchived ?? "") === "1")); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/chat-health/stream", (request, response) => {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();
  chatHealthStreams.add(response);
  const initial = JSON.stringify({
    type: "ready",
    tab: null,
    overview: chatHealth.listTabs(false).overview,
    settings: chatHealth.settings(),
    at: new Date().toISOString()
  });
  response.write(`event: telemetry\ndata: ${initial}\n\n`);
  const keepAlive = setInterval(() => {
    try { response.write(": keepalive\n\n"); } catch {}
  }, 15000);
  response.on("close", () => {
    clearInterval(keepAlive);
    chatHealthStreams.delete(response);
  });
});
app.get("/api/chat-health/tabs/:tabKey", (request, response) => {
  try {
    const tab = chatHealth.getTab(String(request.params.tabKey));
    if (!tab) return response.status(404).json({ error: "Chat tab not found." });
    response.json(tab);
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/chat-health/tabs/:tabKey/history", (request, response) => {
  try { response.json(chatHealth.history(String(request.params.tabKey), Number(request.query.limit ?? 180))); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/chat-health/history", (request, response) => {
  try { response.json(chatHealth.history(String(request.query.tabKey ?? "") || undefined, Number(request.query.limit ?? 180))); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/chat-health/settings", (_request, response) => response.json(chatHealth.settings()));
app.patch("/api/chat-health/settings", (request, response) => {
  try {
    const settings = chatHealth.updateSettings((request.body ?? {}) as Record<string, unknown>);
    store.audit("chat_health", "settings_updated", settings);
    broadcastChatHealth();
    response.json(settings);
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/benchmarks/response-speed/sample", (request, response) => {
  if (!isLocalHost(request)) return response.status(403).json({ error: "Localhost only." });
  const origin = String(request.headers.origin ?? "");
  if (origin && !/^chrome-extension:\/\/[a-z]{32}$/i.test(origin)) return response.status(403).json({ error: "Extension origin required." });
  try { return response.json(responseSpeed.save((request.body ?? {}) as Record<string, unknown>)); }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/benchmarks/response-speed/summary", (request, response) => {
  if (!isLocalHost(request)) return response.status(403).json({ error: "Localhost only." });
  return response.json(responseSpeed.summary());
});
app.get("/api/benchmarks/response-speed/recent", (request, response) => {
  if (!isLocalHost(request)) return response.status(403).json({ error: "Localhost only." });
  return response.json({ samples: responseSpeed.recent(Number(request.query.limit ?? 10)) });
});
app.get("/api/benchmarks/response-speed/export.csv", (request, response) => {
  if (!isLocalHost(request)) return response.status(403).json({ error: "Localhost only." });
  response.type("text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", "attachment; filename=nhd-chatgpt-plus-speed.csv");
  return response.send(responseSpeed.exportCsv());
});
app.post("/api/chat-health/report", (request, response) => {
  try {
    const reportInput = (request.body ?? {}) as Record<string, unknown>;
    let result = chatHealth.report(reportInput);
    let chatJournal: Record<string, unknown> | null = null;
    const journalEligible = reportInput.chatFocused === true || reportInput.journalFlushComplete === true;
    if (journalEligible && Array.isArray(reportInput.visibleMessages)) {
      try {
        chatJournal = workspaceMemory.ingestChatSnapshot(
          result.conversationId,
          reportInput.visibleMessages as Array<{ key?: string; ordinal?: number; role: string; content: string }>,
          { pageTitle: result.pageTitle, url: result.url, source: reportInput.journalFlushComplete === true ? "chat_health_full_flush" : "chat_health_delta", focused: true },
        ) as Record<string, unknown>;
      } catch (journalError) {
        chatJournal = { stored: false, reason: journalError instanceof Error ? journalError.message : String(journalError) };
        store.audit("project_chat_journal", "ingest_failed", { conversationId: result.conversationId, error: String(chatJournal.reason ?? "unknown") });
      }
    }
    if (result.automation.due && reportInput.journalFlushComplete !== true) {
      broadcastChatHealth(result);
      return response.json({ ...result, chatJournal, flushRequested: true, flushReason: "Full visible-message journal flush is required before automatic handoff checkpoint." });
    }
    if (result.automation.due) {
      try {
        const prior = workspaceMemory.bootstrap(undefined, { maxChars: 6_000, recentLimit: 4, activate: true }) as any;
        const previous = prior?.checkpoint?.sequence
          ? ` Previous workspace checkpoint #${prior.checkpoint.sequence} remains the source of semantic work context.`
          : " No previous workspace checkpoint was available.";
        const tabLabel = result.pageTitle || result.conversationId || result.tabKey;
        const checkpoint = workspaceMemory.checkpoint(undefined, {
          kind: "operational",
          summary: `Automatic Chat Health handoff marker for tab "${tabLabel}" (${result.tabKey}). Performance crossed the configured threshold with score ${result.score}/100 (${result.level}), FPS ${result.fps ?? "n/a"}, heap ${result.heapMb ?? "n/a"} MB, DOM ${result.domNodes ?? "n/a"}, long tasks ${result.longTasksPerMin ?? "n/a"}/min.${previous}${chatJournal?.stored ? " Focused visible user/assistant messages were persisted in the project chat journal." : " No focused project-bound chat snapshot was persisted in this report."}`,
          nextAction: "Open a fresh ChatGPT chat and use context_bootstrap; resume from the latest semantic checkpoint.",
          objective: "Operational handoff only; do not replace the project's semantic objective.",
        });
        result = chatHealth.markAutoCheckpoint(result, checkpoint.sequence);
        store.audit("chat_health", "auto_checkpoint", { tabKey: result.tabKey, tabId: result.tabId, conversationId: result.conversationId, score: result.score, level: result.level, checkpointSequence: checkpoint.sequence });
      } catch (checkpointError) {
        const message = checkpointError instanceof Error ? checkpointError.message : String(checkpointError);
        store.audit("chat_health", "auto_checkpoint_failed", { tabKey: result.tabKey, conversationId: result.conversationId, error: message });
        result = { ...result, automation: { ...result.automation, due: false, reason: `Auto-checkpoint failed: ${message}` } };
      }
    }
    broadcastChatHealth(result);
    response.json({ ...result, chatJournal, flushRequested: false });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/api/chat-health/tabs/:tabKey/handoff/ack", (request, response) => {
  try { response.json(chatHealth.acknowledgeHandoff(String(request.params.tabKey))); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/chat-health/tabs/:tabKey/archive", (request, response) => {
  try {
    const result = chatHealth.archiveTab(String(request.params.tabKey));
    store.audit("chat_health", "tab_archived", result);
    response.json(result);
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/chat-health/handoff/ack", (request, response) => {
  try { response.json(chatHealth.acknowledgeHandoff(String(request.body?.tabKey ?? "") || undefined)); }
  catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/tools", async (_request, response) => {
  const tools = getWorkstationToolInventory(dashboardMcp, config);
  const [desktopStatus, browserStatus, pdfStatus] = await Promise.all([desktop.status(), browser.status(), pdf.status()]);
  const videoStatus = video.status();
  const availableIntakeRoots = intake.status().availableRoots;
  for (const tool of tools) {
    if (tool.group === "Desktop" && tool.enabled && !desktopStatus.companion) Object.assign(tool, { enabled: false, status: "disabled", reason: "Desktop Companion chÃƒÆ’Ã¢â‚¬Â Ãƒâ€šÃ‚Â°a kÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¿t nÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“i trong phiÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Âªn Windows hiÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¡n tÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡i." });
    if (tool.group === "Browser" && tool.enabled && !browserStatus.executable) Object.assign(tool, { enabled: false, status: "disabled", reason: "KhÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â´ng tÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¬m thÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¥y Chromium browser ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã¢â‚¬Â Ãƒâ€šÃ‚Â°ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â£c hÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â trÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â£." });
    if (tool.group === "Intake" && tool.enabled && availableIntakeRoots === 0) Object.assign(tool, { enabled: false, status: "disabled", reason: "KhÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â´ng cÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³ thÃƒÆ’Ã¢â‚¬Â Ãƒâ€šÃ‚Â° mÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â¥c intake nÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â o khÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â£ dÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Â¥ng." });
    if (tool.group === "Video" && tool.enabled && !videoStatus.available) Object.assign(tool, { enabled: false, status: "disabled", reason: "Video Intelligence requires FFmpeg and ffprobe." });
    else if (tool.group === "Video" && tool.enabled && !videoStatus.localAsr) Object.assign(tool, { status: "partial", reason: "Video/caption/keyframe analysis works; local speech transcription is unavailable." });
    if (tool.name === "pdf_document" && tool.enabled) {
      const worker = pdfStatus.worker as Record<string, unknown>;
      if (!worker.render) Object.assign(tool, { status: "partial", reason: "ÃƒÆ’Ã¢â‚¬Å¾Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Âc/search PDF hoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡t ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ng; page rendering chÃƒÆ’Ã¢â‚¬Â Ãƒâ€šÃ‚Â°a cÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³ worker." });
      else if (config.ocrEnabled && !worker.ocr) Object.assign(tool, { status: "partial", reason: "ÃƒÆ’Ã¢â‚¬Å¾Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»Ãƒâ€šÃ‚Âc/search/render PDF hoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â¡t ÃƒÆ’Ã¢â‚¬Å¾ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚Â»ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ng; OCR chÃƒÆ’Ã¢â‚¬Â Ãƒâ€šÃ‚Â°a cÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â³ Tesseract hoÃƒÆ’Ã‚Â¡Ãƒâ€šÃ‚ÂºÃƒâ€šÃ‚Â·c language data." });
    }
  }
  response.json({ version: VERSION, total: tools.length, enabled: tools.filter((tool) => tool.enabled).length, disabled: tools.filter((tool) => !tool.enabled).length, partial: tools.filter((tool) => tool.status === "partial").length, tools });
});
app.get("/api/plans", (request, response) => {
  try {
    const root = typeof request.query.root === "string" && request.query.root ? request.query.root : undefined;
    const taskRunId = typeof request.query.task_run_id === "string" && request.query.task_run_id ? request.query.task_run_id : undefined;
    const state = typeof request.query.state === "string" && request.query.state ? request.query.state as any : undefined;
    response.json({ stats: plans.stats(), plans: plans.list({ root, taskRunId, state, limit: Number(request.query.limit ?? 50) }) });
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/plans/:id", (request, response) => { try { response.json(plans.get(String(request.params.id))); } catch (error) { response.status(404).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.post("/api/plans", (request, response) => { try { response.json(plans.create({ kind: request.body?.kind, title: String(request.body?.title ?? ""), objective: request.body?.objective == null ? undefined : String(request.body.objective), root: request.body?.root == null ? undefined : String(request.body.root), taskRunId: request.body?.task_run_id == null ? undefined : String(request.body.task_run_id), phases: Array.isArray(request.body?.phases) ? request.body.phases : [] })); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.post("/api/plans/:id/action", (request, response) => {
  try {
    const planId = String(request.params.id); const action = String(request.body?.action ?? ""); const phase = String(request.body?.phase_key ?? "");
    if (action === "start") return response.json(plans.start(planId));
    if (action === "pause") return response.json(plans.pause(planId, request.body?.note));
    if (action === "resume") return response.json(plans.resume(planId));
    if (action === "verify_phase") return response.json(plans.verifyPhase(planId, phase, { summary: request.body?.summary, receiptId: request.body?.receipt_id }));
    if (action === "block_phase") return response.json(plans.blockPhase(planId, phase, String(request.body?.note ?? "Blocked.")));
    if (action === "fail_phase") return response.json(plans.failPhase(planId, phase, String(request.body?.note ?? "Phase failed.")));
    if (action === "retry_phase") return response.json(plans.retryPhase(planId, phase, request.body?.note));
    if (action === "cancel") return response.json(plans.cancel(planId, request.body?.note));
    throw new Error("Unsupported plan action.");
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/projects", (request, response) => {
  try {
    const limit = Math.max(1, Math.min(Number(request.query.limit ?? 100), 200));
    const recent = workspaceMemory.recentProjects(limit);
    const runs = taskRuns.list(undefined, 200);
    const planRows = plans.list({ limit: 200 });
    const terminalStates = new Set(["completed", "failed", "cancelled", "expired"]);
    const enriched = recent.map((project) => {
      const projectRuns = runs.filter((run) => String(run.root ?? "").toLowerCase() === String(project.root).toLowerCase());
      const activeTask = projectRuns.find((run) => !terminalStates.has(String(run.state))) ?? null;
      const lastTask = projectRuns[0] ?? null;
      const projectPlans = planRows.filter((plan) => String(plan.root ?? "").toLowerCase() === String(project.root).toLowerCase());
      const activePlan = projectPlans.find((plan) => ["running","blocked","paused","planned"].includes(plan.state)) ?? null;
      const lastPlan = projectPlans[0] ?? null;
      return {
        ...project,
        activeTask: activeTask ? { id: activeTask.id, state: activeTask.state, objective: activeTask.objective, updatedAt: activeTask.updatedAt } : null,
        lastTask: lastTask ? { id: lastTask.id, state: lastTask.state, objective: lastTask.objective, updatedAt: lastTask.updatedAt } : null,
        activePlan: activePlan ? { id: activePlan.id, state: activePlan.state, title: activePlan.title, percent: activePlan.percent, currentPhase: activePlan.currentPhase, nextPhase: activePlan.nextPhase, updatedAt: activePlan.updatedAt } : null,
        lastPlan: lastPlan ? { id: lastPlan.id, state: lastPlan.state, title: lastPlan.title, percent: lastPlan.percent, updatedAt: lastPlan.updatedAt } : null,
      };
    });
    response.json({ projectWorkspaceRoot: config.projectWorkspaceRoot, activeProjectRoot: workspaceMemory.stats().activeProjectRoot, projects: enriched });
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/projects/status", (request, response) => { try { response.json(projects.status(String(request.query.root ?? config.roots[0]))); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/api/projects/daily-progress", (request, response) => { try { const root = String(request.query.root ?? workspaceMemory.stats().activeProjectRoot ?? ""); const date = typeof request.query.date === "string" ? request.query.date : undefined; response.json(workspaceMemory.dailyProgress(root || undefined, date)); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.put("/api/projects/daily-progress", (request, response) => { try { const root = String(request.body?.root ?? workspaceMemory.stats().activeProjectRoot ?? ""); response.json(workspaceMemory.setDailyPlan(root || undefined, { date: request.body?.date, title: String(request.body?.title ?? ""), note: request.body?.note == null ? undefined : String(request.body.note), items: Array.isArray(request.body?.items) ? request.body.items : [] })); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.patch("/api/projects/daily-progress", (request, response) => { try { const root = String(request.body?.root ?? workspaceMemory.stats().activeProjectRoot ?? ""); response.json(workspaceMemory.updateDailyProgress(root || undefined, request.body?.date, Array.isArray(request.body?.updates) ? request.body.updates : [], request.body?.note == null ? undefined : String(request.body.note))); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/api/activity", (_request, response) => response.json({ events: store.recentAudit(200) }));
app.get("/api/config", (_request, response) => {
  const { companionSecret: _omittedCompanionSecret, ...dashboardConfig } = config;
  response.json(dashboardConfig);
});
app.patch("/api/config", (request, response) => {
  for (const key of ["writeEnabled", "terminalEnabled", "skillsEnabled", "screenEnabled", "desktopEnabled", "browserEnabled", "visualDesktopEnabled", "intakeEnabled", "ocrEnabled", "openAiSecureTunnelEnabled"] as const) if (typeof request.body?.[key] === "boolean") config[key] = request.body[key];
  if (Array.isArray(request.body?.intakeRoots)) config.intakeRoots = request.body.intakeRoots.map(String).filter(Boolean).slice(0, 20);
  if (typeof request.body?.projectWorkspaceRoot === "string" && request.body.projectWorkspaceRoot.trim()) config.projectWorkspaceRoot = files.resolvePath(request.body.projectWorkspaceRoot.trim());
  if (typeof request.body?.openAiSecureTunnelProfile === "string" && request.body.openAiSecureTunnelProfile.trim()) config.openAiSecureTunnelProfile = request.body.openAiSecureTunnelProfile.trim().slice(0,120);
  if (typeof request.body?.openAiTunnelClientPath === "string" && request.body.openAiTunnelClientPath.trim()) config.openAiTunnelClientPath = resolve(request.body.openAiTunnelClientPath.trim());
  saveConfig(config);
  store.audit("config", "updated", { writeEnabled: config.writeEnabled, terminalEnabled: config.terminalEnabled, skillsEnabled: config.skillsEnabled, screenEnabled: config.screenEnabled, desktopEnabled: config.desktopEnabled, browserEnabled: config.browserEnabled, visualDesktopEnabled: config.visualDesktopEnabled, intakeEnabled: config.intakeEnabled, ocrEnabled: config.ocrEnabled, intakeRootCount: config.intakeRoots.length });
  response.json({ ok: true });
});
app.get("/api/skills", (_request, response) => response.json({ enabled: config.skillsEnabled, skills: skills.list("", undefined, true), validation: skills.validate() }));
app.patch("/api/skills/:id", (request, response) => {
  try {
    const skill = skills.setEnabled(String(request.params.id), request.body?.enabled !== false);
    fastSkillValidation = skills.validate();
    saveConfig(config);
    store.audit("skill_config", "updated", { id: skill.id, enabled: skill.enabled });
    response.json({ skill });
  } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/emergency", async (request, response) => {
  config.emergencyStop = request.body?.enabled !== false;
  if (config.emergencyStop) {
    config.tunnelEnabled = false;
    config.openAiSecureTunnelEnabled = false;
    await tunnel.stop();
    await openAiTunnel.stop();
    terminalSessions.emergencyStop();
    sbceExecutor.stop();
    taskRuns.pauseForEmergencyStop("Emergency Stop enabled by owner.");
  } else {
    terminalSessions.clearEmergencyStop();
  }
  saveConfig(config);
  store.audit("emergency_stop", config.emergencyStop ? "enabled" : "disabled", {});
  response.json({ emergencyStop: config.emergencyStop });
});
app.post("/api/index", async (request, response) => { try { response.json(await files.index(String(request.body?.root ?? config.roots[0]), Number(request.body?.maxFiles ?? 20000))); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.post("/api/search", (request, response) => response.json({ hits: files.search(String(request.body?.query ?? ""), Number(request.body?.limit ?? 30)) }));
app.get("/api/terminal/running", (_request, response) => response.json({ runs: terminal.listRunning() }));
app.get("/api/screen/sources", async (_request, response) => { try { response.json(await screen.list()); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/api/desktop/windows", async (_request, response) => { try { response.json(await desktop.windows()); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/api/intake/recent", (_request, response) => { try { response.json({ files: intake.listRecent({ limit: 30 }) }); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/api/pdf/status", async (_request, response) => { try { response.json(await pdf.status()); } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });

app.get("/api/setup/status", (_request,response) => response.json({version:VERSION,cloudflare:firstRunCloudflare.status(),openAiTunnel:openAiTunnel.status(),localMcpUrl:"http://127.0.0.1:"+config.localHarnessPort+"/mcp"}));
app.post("/api/setup/cloudflare/plan", (request,response) => { try {response.json(cloudflareSetupPlan({domain:String(request.body?.domain??""),subdomain:String(request.body?.subdomain??"mcp")}));}catch(error){response.status(400).json({error:error instanceof Error?error.message:String(error)});} });
app.post("/api/setup/cloudflare/login", (_request,response) => {try {response.json(firstRunCloudflare.login());}catch(error){response.status(503).json({error:error instanceof Error?error.message:String(error)});} });
app.post("/api/setup/cloudflare/provision", async(request,response) => {
  try {
    const result=await firstRunCloudflare.provision({
      domain:String(request.body?.domain??""),
      subdomain:String(request.body?.subdomain??"mcp"),
      confirmed:request.body?.confirmed===true
    });
    store.audit("first_run","cloudflare_provisioned",{hostname:result.hostname,tunnelId:result.tunnelId});
    let startRequested=false;
    let startError:string|null=null;
    try {
      config.tunnelEnabled=true;
      saveConfig(config);
      await tunnel.start(); // Supervisor reloads saved Cloudflare config on /start.
      startRequested=true;
    } catch(error) {
      config.tunnelEnabled=false;
      saveConfig(config);
      startError=error instanceof Error?error.message:String(error);
      store.audit("first_run","cloudflare_start_degraded",{hostname:result.hostname,error:startError});
    }
    response.json({...result,startRequested,startError,
      next:startRequested?"Tunnel đã nhận lệnh bật; kiểm tra HTTPS/OAuth rồi thêm NHD vào ChatGPT."
        :"Tunnel và DNS đã tạo nhưng chưa bật được. Sử dụng Bật lại tunnel, KHÔNG tạo lại tunnel."});
  } catch(error) { response.status(409).json({error:error instanceof Error?error.message:String(error)}); }
});
app.get("/api/setup/cloudflare/verify", async(_request,response) => response.json(await firstRunCloudflare.verify()));
app.post("/api/setup/complete", (request,response) => {if(request.body?.confirmed!==true)return response.status(400).json({error:"Owner confirmation required."});const stamp={version:VERSION,confirmedByOwner:true,at:new Date().toISOString()};writeFileSync(resolve(config.dataDir,"setup-complete.json"),JSON.stringify(stamp,null,2),{encoding:"utf8",mode:0o600});store.audit("first_run","owner_setup_acknowledged",{version:VERSION});response.json({ok:true});});
app.get("/api/openai-tunnel/status", (_request, response) => response.json(openAiTunnel.status()));
app.post("/api/openai-tunnel/doctor", async (_request, response) => { try { response.json(await openAiTunnel.doctor()); } catch(error){ response.status(503).json({ error:error instanceof Error?error.message:String(error), tunnel:openAiTunnel.status() }); } });
app.post("/api/openai-tunnel/start", async (_request, response) => {
  if (config.emergencyStop) return response.status(409).json({ error:"Emergency stop is enabled." });
  try { const status=await openAiTunnel.start(); config.openAiSecureTunnelEnabled=true; saveConfig(config); response.json(status); }
  catch(error){ config.openAiSecureTunnelEnabled=false; saveConfig(config); response.status(503).json({ error:error instanceof Error?error.message:String(error), tunnel:openAiTunnel.status() }); }
});
app.post("/api/openai-tunnel/stop", async (_request, response) => { config.openAiSecureTunnelEnabled=false; saveConfig(config); response.json(await openAiTunnel.stop()); });
app.post("/api/tunnel/start", async (_request, response) => {
  if (config.emergencyStop) return response.status(409).json({ error: "Emergency stop is enabled." });
  config.tunnelEnabled = true;
  saveConfig(config);
  try { response.json(await tunnel.start()); }
  catch (error) { response.status(503).json({ error: error instanceof Error ? error.message : String(error), tunnel: tunnel.status() }); }
});
app.post("/api/tunnel/stop", async (_request, response) => {
  config.tunnelEnabled = false;
  saveConfig(config);
  response.json(await tunnel.stop());
});
app.post("/api/oauth/rotate", (_request, response) => { store.db.prepare("UPDATE oauth_tokens SET revoked=1").run(); config.pairingCode = Math.random().toString(16).slice(2, 10).toUpperCase(); saveConfig(config); response.json({ pairingCode: config.pairingCode }); });

app.use(localOnly, express.static(resolve(process.cwd(), "dashboard")));
app.use((request, response) => { if (!isLocalHost(request)) return response.status(404).end(); response.sendFile(resolve(process.cwd(), "dashboard", "index.html")); });

let listenerOwned = false;
let localHarnessServer: ReturnType<typeof localMcpApp.listen> | null = null;

function startLocalHarnessListener() {
  if (!config.localHarnessEnabled || localHarnessServer) { harnessConnections.setLocalIngress({ enabled:config.localHarnessEnabled, port:config.localHarnessPort, listening:Boolean(localHarnessServer) }); return; }
  const candidate=localMcpApp.listen(config.localHarnessPort,"127.0.0.1");
  candidate.once("listening",()=>{ localHarnessServer=candidate; harnessConnections.setLocalIngress({ enabled:true, port:config.localHarnessPort, listening:true, lastError:null, startedAt:new Date().toISOString() }); store.audit("harness","local_ingress_started",{host:"127.0.0.1",port:config.localHarnessPort,model:"multi-harness-single-core-v1"}); console.log(`NHD MCP local harness listening at http://127.0.0.1:${config.localHarnessPort}/mcp`); });
  candidate.once("error",(error:NodeJS.ErrnoException)=>{ if(localHarnessServer===candidate)localHarnessServer=null; const message=error?.message||String(error); harnessConnections.setLocalIngress({ enabled:true, port:config.localHarnessPort, listening:false, lastError:message, startedAt:null }); store.audit("harness","local_ingress_degraded",{port:config.localHarnessPort,code:error?.code??null,error:message}); });
}

const failListenerStartup = (error: unknown) => {
  if (listenerOwned) return;
  const message = error instanceof Error ? error.message : String(error);
  try { store.audit("runtime", "listener_bind_failed", { error: message }); } catch {}
  runtimeLifecycle.markExit("listener-bind-failed");
  console.error(`ChatGPT Workstation MCP Bridge failed to bind http://${config.host}:${config.port}: ${message}`);
  process.exit(1);
};

const httpServer = app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    failListenerStartup(error);
    return;
  }
  listenerOwned = true;
  if(!config.emergencyStop)try { sbceExecutor.start(); } catch (error) { store.audit("sbce", "startup_degraded", { error: error instanceof Error ? error.message : String(error) }); }
  httpServer.off("error", failListenerStartup);
  console.log(`ChatGPT Workstation MCP Bridge listening at http://${config.host}:${config.port}`);
  startLocalHarnessListener();
  if(config.openAiSecureTunnelEnabled) void openAiTunnel.ensureStarted().catch((error)=>store.audit("openai_secure_tunnel","startup_degraded",{error:error instanceof Error?error.message:String(error)}));
  const recoveredTaskRuns = taskRuns.recoverAfterRestart();
  if (recoveredTaskRuns > 0) store.audit("task_runtime", "restart_recovery", { recovered: recoveredTaskRuns });
  try { files.startWatch(config.projectWorkspaceRoot); }
  catch (watchError) { store.audit("index_watch_start", "degraded", { root: config.projectWorkspaceRoot, error: watchError instanceof Error ? watchError.message : String(watchError) }); }
  store.audit("runtime", "started", runtimeLifecycle.status());
  if (config.tunnelEnabled && !config.emergencyStop) void tunnel.start().catch((error) => store.audit("tunnel_supervisor", "start_failed", { error: error instanceof Error ? error.message : String(error) }));
});
httpServer.on("error", failListenerStartup);

const stopBackendOnly = (reason: "SIGINT" | "SIGTERM") => {
  runtimeLifecycle.markExit(reason);
  files.stopWatch();
  browser.stop();
  try { localHarnessServer?.close(); } catch {}
  harnessConnections.setLocalIngress({ listening:false, startedAt:null });
  sbceExecutor.stop();
  // Intentionally preserve the external Cloudflare tunnel supervisor across backend restarts.
  tunnel.close();
  openAiTunnel.close();
  try { governor.close(); } catch {}
  process.exit(0);
};
process.on("SIGINT", () => stopBackendOnly("SIGINT"));
process.on("SIGTERM", () => stopBackendOnly("SIGTERM"));





