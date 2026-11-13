import type { AppConfig } from "./config.js";
import type { Store } from "./db.js";
import type { FileService } from "./files.js";
import type { TerminalService } from "./terminal.js";
import type { OfficeService } from "./office.js";
import type { SkillService } from "./skills.js";
import type { ScreenService } from "./screen.js";
import type { ProjectService } from "./project.js";
import type { DocumentService } from "./document.js";
import type { DesktopService } from "./desktop.js";
import type { IntakeService } from "./intake.js";
import type { PdfService } from "./pdf.js";
import type { DesktopIntakeWorkflow } from "./desktop-intake.js";
import type { BrowserService } from "./browser.js";
import type { TerminalSessionCoordinator } from "./terminal-session-coordinator.js";
import type { TaskRunManager } from "./task-runtime.js";
import type { WorkspaceContextService } from "./workspace-memory.js";
import type { VideoService } from "./video.js";
import type { CocCocBridgeService } from "./coc-coc-bridge.js";
import type { LocalIntelligenceService } from "./local-intelligence.js";
import type { ToolGovernorService } from "./tool-governor.js";
import type { ExecutionLaneService } from "./execution-lanes.js";
import type { IsolatedAgentService } from "./isolated-agent.js";
import type { BackgroundTurboService } from "./background-turbo.js";
import type { HealthSnapshotService } from "./health-snapshot.js";
import type { PlanStateService } from "./plan-state.js";
import type { HarnessConnectionService } from "./harness-connections.js";
import type { ResultTelemetryService } from "./result-telemetry.js";
import type { ResultPayloadGatewayService } from "./result-payload-gateway.js";
import type { SbceProcess } from "./sbce-process.js";
import type { ProjectRagWatcher } from "./project-rag-watch.js";

/**
 * One explicit runtime dependency container shared by every stateless MCP server
 * instance. Services with process/runtime lifecycle live here; an individual
 * McpServer owns only protocol registration/transport state.
 */
export type WorkstationRuntime = Readonly<{
  config: AppConfig;
  store: Store;
  files: FileService;
  terminal: TerminalService;
  office: OfficeService;
  skills: SkillService;
  screen: ScreenService;
  projects: ProjectService;
  documents: DocumentService;
  desktop: DesktopService;
  intake: IntakeService;
  pdf: PdfService;
  desktopIntake: DesktopIntakeWorkflow;
  browser?: BrowserService;
  terminalSessions?: TerminalSessionCoordinator;
  taskRuns?: TaskRunManager;
  workspaceMemory?: WorkspaceContextService;
  video?: VideoService;
  cocCocBridge?: CocCocBridgeService;
  localIntelligence?: LocalIntelligenceService;
  executionLanes?: ExecutionLaneService;
  isolatedAgent?: IsolatedAgentService;
  backgroundTurbo?: BackgroundTurboService;
  healthSnapshot?: HealthSnapshotService<any>;
  planState?: PlanStateService;
  governor?: ToolGovernorService;
  harnessConnections?: HarnessConnectionService;
  resultTelemetry?: ResultTelemetryService;
  resultPayloadGateway?: ResultPayloadGatewayService;
  sbceExecutor?: SbceProcess;
  projectRagWatch?: ProjectRagWatcher;
}>;

export function createWorkstationRuntime(input: WorkstationRuntime): WorkstationRuntime {
  if (!input?.config || !input?.store || !input?.files || !input?.terminal || !input?.office) {
    throw new Error("WorkstationRuntime is missing required core services.");
  }
  return Object.freeze({ ...input });
}


