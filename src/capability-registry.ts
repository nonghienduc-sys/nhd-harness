import type { AppConfig } from "./config.js";

export type CapabilityPermission = "read" | "write" | "terminal" | "skills" | "screen" | "desktop" | "browser" | "intake" | "video" | "mixed";
export type CapabilityLane = "background" | "isolated" | "either";
export type CapabilityRisk = "read-only" | "reversible" | "mutation" | "destructive" | "dynamic";
export type CapabilityOfficeApplication = "word" | "excel" | "powerpoint" | "outlook";

export type CapabilitySnapshot = {
  files: { read: boolean; write: boolean };
  office: {
    offlineRead: boolean;
    offlineWrite: boolean;
    liveRead: boolean;
    liveWrite: boolean;
    applications?: Partial<Record<CapabilityOfficeApplication, boolean>>;
    liveWriteApplications?: Partial<Record<CapabilityOfficeApplication, boolean>>;
  };
  browser: { enabled: boolean; dom: boolean; screenshot: boolean; dedicatedChromium?: boolean; cocCocConnected?: boolean; cocCocTabs?: number; isolatedBrowser?: boolean };
  desktop: { enabled: boolean; uia: boolean; visual: boolean };
  terminal: { enabled: boolean };
  intake: { enabled: boolean };
  pdf: { enabled: boolean };
};

export type RuntimeCapabilityInput = {
  writeEnabled: boolean;
  terminalEnabled: boolean;
  screenEnabled: boolean;
  desktopEnabled: boolean;
  browserEnabled: boolean;
  visualDesktopEnabled: boolean;
  intakeEnabled: boolean;
  emergencyStop: boolean;
  office: { companion: boolean; word: boolean; excel: boolean; powerpoint: boolean; outlook: boolean };
  browser: { executable: string | null; cocCocConnected?: boolean; cocCocTabs?: number; isolatedBrowser?: boolean };
  desktop: { companion: boolean };
  intake: { availableRoots: number };
  pdf: { nativeTextExtraction: boolean };
};

export type ToolInventoryItem = {
  name: string;
  group: string;
  description: string;
  registered: boolean;
  enabled: boolean;
  status: "enabled" | "disabled" | "partial";
  reason: string | null;
  permission: CapabilityPermission;
  destructive: boolean;
  mutation: boolean;
  risk: CapabilityRisk;
  lane: CapabilityLane;
  openWorld: boolean;
  runtimeRequirements: string[];
  /** v0.24.15: false for deprecated names hidden from tools/list behind a facade (still callable). */
  listed: boolean;
};

export const BACKGROUND_LANE_CAPABILITIES = Object.freeze([
  "files", "terminal-non-gui", "office-direct", "coc-coc-dom-background", "pdf", "ocr", "local-ai", "project-memory",
] as const);

export const BACKGROUND_LANE_FORBIDDEN = Object.freeze([
  "host-mouse", "host-keyboard-injection", "host-window-activation", "coordinate-click", "foreground-tab-switch",
] as const);

const EVOLUTION_MUTATIONS = new Set(["self_evolution_record_feedback", "self_evolution_propose", "self_evolution_feedback"]);
// v0.24.15: facades whose op set includes a mutating member (members keep their own metadata).
const FACADE_MUTATIONS = new Set(["isolated_browser_act", "isolated_agent_control", "screen_capture", "project_open", "execution_control"]);
const PROJECT_PARTIAL_TOOLS = new Set(["project_open", "project_memory", "project_decision", "project_sources", "project_snapshot"]);
const WRITE_TOOLS = new Set([
  "fs_preview_write", "fs_preview_move", "fs_preview_delete",
  "office_preview_edit", "office_apply_edit", "office_preview_export_pdf", "office_apply_export_pdf",
  "office_live_preview_edit", "office_live_apply_edit", "office_live_insert_at_cursor", "office_live_append",
  "document_edit_preview", "document_edit_apply",
  "project_rag_ingest",
  ...PROJECT_PARTIAL_TOOLS,
]);
const MUTATION_PATTERN = /(?:_apply_|_preview_|_click|_fill|_action|_navigate|_execute|_cancel|_write|_move|_delete|checkpoint|working_state|project_memory|project_decision|project_sources|project_snapshot)/;

export function capabilityGroup(name: string): string {
  if (name.startsWith("self_evolution_")) return "Self-Evolution";
  if (name.startsWith("execution_")) return "Execution";
  if (name.startsWith("isolated_")) return "Isolated Agent";
  if (name.startsWith("local_ai_")) return "Local AI";
  if (name.startsWith("context_")) return "Context";
  if (name.startsWith("task_")) return "Task";
  if (name.startsWith("coc_coc_") || name.startsWith("browser_")) return "Browser";
  if (name.startsWith("desktop_")) return "Desktop";
  if (name.startsWith("intake_")) return "Intake";
  if (name.startsWith("pdf_")) return "PDF";
  if (name.startsWith("video_") || name.startsWith("media_")) return "Video";
  if (name.startsWith("skills_")) return "Skills";
  if (name.startsWith("screen_")) return "Screen";
  if (name.startsWith("project_")) return "Project";
  if (name.startsWith("document_")) return "Document";
  if (name.startsWith("fs_")) return "Filesystem";
  if (name.startsWith("terminal_")) return "Terminal";
  if (name.startsWith("office_") || name.startsWith("outlook_")) return "Office";
  return "Workstation";
}

export function capabilityPermission(name: string): CapabilityPermission {
  if (EVOLUTION_MUTATIONS.has(name)) return "write";
  if (name.startsWith("self_evolution_")) return "read";
  if (name.startsWith("execution_") || name.startsWith("isolated_") || name === "tool_governor" || name.startsWith("context_") || name.startsWith("task_")) return "mixed";
  if (name.startsWith("local_ai_")) return "read";
  if (name.startsWith("coc_coc_") || name.startsWith("browser_")) return "browser";
  if (name.startsWith("desktop_")) return "desktop";
  if (name.startsWith("intake_") || name.startsWith("pdf_")) return "intake";
  if (name.startsWith("video_") || name.startsWith("media_")) return "video";
  if (name.startsWith("skills_")) return "skills";
  if (name.startsWith("screen_")) return "screen";
  if (name.startsWith("terminal_")) return "terminal";
  if (WRITE_TOOLS.has(name) || name.startsWith("fs_apply_")) return "write";
  return "read";
}

export function capabilityIsMutation(name: string): boolean {
  return EVOLUTION_MUTATIONS.has(name) || FACADE_MUTATIONS.has(name) || name === "project_rag_ingest" || MUTATION_PATTERN.test(name);
}

export function capabilityLane(name: string): CapabilityLane {
  if (name.startsWith("isolated_")) return "isolated";
  if (name.startsWith("desktop_") || name.startsWith("screen_") || name.startsWith("browser_") || name.startsWith("coc_coc_") || name.startsWith("office_")) return "either";
  return "background";
}

export function capabilityRisk(name: string, annotations?: Record<string, unknown>): CapabilityRisk {
  if (annotations?.destructiveHint) return "destructive";
  if (name.startsWith("terminal_")) return "dynamic";
  if (capabilityIsMutation(name)) return "mutation";
  if (capabilityPermission(name) === "write") return "reversible";
  return "read-only";
}

export function capabilityRuntimeRequirements(name: string): string[] {
  const permission = capabilityPermission(name);
  if (name.startsWith("isolated_")) return ["isolated-agent"];
  if (name.startsWith("coc_coc_")) return ["browser", "coc-coc-extension"];
  if (name.startsWith("browser_")) return ["browser"];
  if (name.startsWith("office_live_")) return ["write", "office-companion"];
  if (name.startsWith("office_") || name.startsWith("outlook_")) return permission === "write" ? ["write", "office"] : ["office"];
  if (permission === "write") return ["write"];
  if (permission === "terminal") return ["terminal"];
  if (permission === "screen") return ["screen"];
  if (permission === "desktop") return ["desktop"];
  if (permission === "browser") return ["browser"];
  if (permission === "intake") return ["intake"];
  if (permission === "skills") return ["skills"];
  if (permission === "video") return ["video"];
  return [];
}

export function capabilityStaticMetadata(name: string, annotations?: Record<string, unknown>) {
  return {
    group: capabilityGroup(name),
    permission: capabilityPermission(name),
    mutation: capabilityIsMutation(name),
    destructive: Boolean(annotations?.destructiveHint),
    risk: capabilityRisk(name, annotations),
    lane: capabilityLane(name),
    openWorld: Boolean(annotations?.openWorldHint),
    runtimeRequirements: capabilityRuntimeRequirements(name),
  };
}

export function capabilityRuntimeState(name: string, annotations: Record<string, unknown> | undefined, config: AppConfig) {
  const permission = capabilityPermission(name);
  if (permission === "skills" && !config.skillsEnabled) return { enabled: false, status: "disabled" as const, reason: "Skill Registry is disabled." };
  if (permission === "screen" && (!config.screenEnabled || config.emergencyStop)) return { enabled: false, status: "disabled" as const, reason: config.emergencyStop ? "Emergency Stop is active." : "Screen Access is disabled." };
  if (permission === "desktop" && (!config.desktopEnabled || config.emergencyStop)) return { enabled: false, status: "disabled" as const, reason: config.emergencyStop ? "Emergency Stop is active." : "Desktop Navigation is disabled." };
  if (permission === "browser" && (!config.browserEnabled || config.emergencyStop)) return { enabled: false, status: "disabled" as const, reason: config.emergencyStop ? "Emergency Stop is active." : "Browser Automation is disabled." };
  if (permission === "intake" && (!config.intakeEnabled || config.emergencyStop)) return { enabled: false, status: "disabled" as const, reason: config.emergencyStop ? "Emergency Stop is active." : "Document Intake is disabled." };
  if (permission === "terminal" && (!config.terminalEnabled || config.emergencyStop)) return { enabled: false, status: "disabled" as const, reason: config.emergencyStop ? "Emergency Stop is active." : "PowerShell is disabled." };
  if (permission === "video" && config.emergencyStop) return { enabled: false, status: "disabled" as const, reason: "Emergency Stop is active." };
  if (permission === "write" && (!config.writeEnabled || config.emergencyStop)) return { enabled: false, status: "disabled" as const, reason: config.emergencyStop ? "Emergency Stop is active." : "Write permission is locked." };
  if (permission === "write" && PROJECT_PARTIAL_TOOLS.has(name)) return { enabled: true, status: "partial" as const, reason: "Tool has read and preview/apply operations; mutations remain write-gated." };
  if (annotations?.destructiveHint && config.emergencyStop) return { enabled: false, status: "disabled" as const, reason: "Emergency Stop is active." };
  return { enabled: true, status: "enabled" as const, reason: null };
}

export function getWorkstationToolInventory(server: unknown, config: AppConfig): ToolInventoryItem[] {
  const hidden: Set<string> = (server as any)?._nhdHiddenTools ?? new Set<string>();
  const registry = (server as { _registeredTools?: Record<string, { description?: string; enabled?: boolean; annotations?: Record<string, unknown> }> })._registeredTools ?? {};
  return Object.entries(registry).map(([name, tool]) => {
    const state = capabilityRuntimeState(name, tool.annotations, config);
    const meta = capabilityStaticMetadata(name, tool.annotations);
    return {
      name,
      group: meta.group,
      description: tool.description ?? "",
      registered: true,
      enabled: state.enabled && tool.enabled !== false,
      status: state.status,
      reason: state.reason,
      permission: meta.permission,
      destructive: meta.destructive,
      mutation: meta.mutation,
      risk: meta.risk,
      lane: meta.lane,
      openWorld: meta.openWorld,
      runtimeRequirements: meta.runtimeRequirements,
      listed: !hidden.has(name),
    };
  }).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

export function capabilitiesFromRuntime(input: RuntimeCapabilityInput): CapabilitySnapshot {
  const stopped = input.emergencyStop;
  const officeApps = { word: Boolean(input.office.word), excel: Boolean(input.office.excel), powerpoint: Boolean(input.office.powerpoint), outlook: Boolean(input.office.outlook) };
  const liveRead = input.office.companion && Object.values(officeApps).some(Boolean) && !stopped;
  const canWrite = input.writeEnabled && !stopped;
  const dedicatedChromium = input.browserEnabled && Boolean(input.browser.executable) && !stopped;
  const cocCocConnected = input.browserEnabled && Boolean(input.browser.cocCocConnected) && !stopped;
  const isolatedBrowser = input.browserEnabled && Boolean(input.browser.isolatedBrowser) && !stopped;
  const browserAvailable = dedicatedChromium || cocCocConnected || isolatedBrowser;
  const liveWriteApplications = {
    word: input.office.companion && officeApps.word && canWrite,
    excel: input.office.companion && officeApps.excel && canWrite,
    powerpoint: input.office.companion && officeApps.powerpoint && canWrite,
    outlook: false,
  };
  return {
    files: { read: true, write: canWrite },
    office: {
      offlineRead: true,
      offlineWrite: canWrite,
      liveRead,
      liveWrite: liveWriteApplications.word || liveWriteApplications.excel || liveWriteApplications.powerpoint,
      applications: officeApps,
      liveWriteApplications,
    },
    browser: { enabled: browserAvailable, dom: browserAvailable, screenshot: browserAvailable, dedicatedChromium, cocCocConnected, cocCocTabs: Math.max(0, Number(input.browser.cocCocTabs ?? 0)), isolatedBrowser },
    desktop: { enabled: input.desktopEnabled && input.desktop.companion && !stopped, uia: input.desktopEnabled && input.desktop.companion && !stopped, visual: input.desktopEnabled && input.desktop.companion && input.visualDesktopEnabled && !stopped },
    terminal: { enabled: input.terminalEnabled && !stopped },
    intake: { enabled: input.intakeEnabled && input.intake.availableRoots > 0 && !stopped },
    pdf: { enabled: input.intakeEnabled && input.pdf.nativeTextExtraction && !stopped },
  };
}
