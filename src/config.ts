import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DEFAULT_TOOL_CATALOG_CORE_TOOLS, type ToolCatalogSettings } from "./tool-catalog.js";

export type AppConfig = {
  instanceId: string;
  host: string;
  port: number;
  localHarnessEnabled: boolean;
  localHarnessPort: number;
  officePort: number;
  screenPort: number;
  roots: string[];
  intakeRoots: string[];
  dataDir: string;
  backupDir: string;
  projectWorkspaceRoot: string;
  writeEnabled: boolean;
  terminalEnabled: boolean;
  skillsEnabled: boolean;
  screenEnabled: boolean;
  desktopEnabled: boolean;
  browserEnabled: boolean;
  visualDesktopEnabled: boolean;
  intakeEnabled: boolean;
  ocrEnabled: boolean;
  disabledSkills: string[];
  structuredOnlyClients?: string[];
  toolCatalog?: ToolCatalogSettings;
  documentTemplateTools?: { python?: string; buildScript?: string; formatCheckScript?: string };
  tunnelEnabled: boolean;
  openAiSecureTunnelEnabled: boolean;
  openAiSecureTunnelProfile: string;
  openAiTunnelClientPath: string;
  tunnelMode: "quick" | "named";
  namedTunnelName: string;
  namedTunnelConfig: string;
  publicHostname: string;
  emergencyStop: boolean;
  pairingCode: string;
  companionSecret: string;
  cloudflaredPath: string;
};

const defaultDataDir = process.env.WORKSTATION_MCP_DATA_DIR
  ? resolve(process.env.WORKSTATION_MCP_DATA_DIR)
  : "C:\\ProgramData\\ChatGPTWorkstationBridge";
const fallbackDataDir = resolve(process.cwd(), ".workstation-mcp");

function writableDataDir(): string {
  try {
    mkdirSync(defaultDataDir, { recursive: true });
    return defaultDataDir;
  } catch {
    mkdirSync(fallbackDataDir, { recursive: true });
    return fallbackDataDir;
  }
}

export const DATA_DIR = writableDataDir();
export const CONFIG_PATH = resolve(DATA_DIR, "config.json");

export function defaultConfiguredRoots(): string[] {
  return [existsSync("D:\\") ? "D:\\" : resolve(process.env.USERPROFILE ?? process.cwd())];
}
function defaults(): AppConfig {
  const namedTunnelConfig = resolve(DATA_DIR, "cloudflare", "config.yml");
  const openAiTunnelClientPath = process.env.OPENAI_TUNNEL_CLIENT_PATH ? resolve(process.env.OPENAI_TUNNEL_CLIENT_PATH) : resolve(process.cwd(), "runtime", "tunnel-client.exe");
  const cloudflaredCandidates = [
    process.env.CLOUDFLARED_PATH,
    resolve(process.cwd(), "runtime", "cloudflared.exe"),
    "cloudflared.exe",
  ].filter(Boolean) as string[];
  const userProfile = resolve(process.env.USERPROFILE ?? process.cwd());
  const intakeCandidates = [
    resolve(userProfile, "Downloads"),
    resolve(userProfile, "Documents", "Zalo Received Files"),
  ];
  return {
    instanceId: randomBytes(16).toString("hex"),
    host: "127.0.0.1",
    port: Number(process.env.WORKSTATION_MCP_PORT ?? 39100),
    localHarnessEnabled: process.env.WORKSTATION_MCP_LOCAL_ENABLED !== "0",
    localHarnessPort: Number(process.env.WORKSTATION_MCP_LOCAL_PORT ?? 39104),
    officePort: Number(process.env.WORKSTATION_OFFICE_PORT ?? 39101),
    screenPort: Number(process.env.WORKSTATION_SCREEN_PORT ?? 39102),
    roots: defaultConfiguredRoots(),
    intakeRoots: intakeCandidates.filter((path) => existsSync(path)),
    dataDir: DATA_DIR,
    backupDir: resolve(DATA_DIR, "backups"),
    projectWorkspaceRoot: existsSync("D:\\") ? "D:\\NHD Projects" : resolve(userProfile, "Documents", "NHD Projects"),
    writeEnabled: true,
    terminalEnabled: true,
    skillsEnabled: true,
    screenEnabled: true,
    desktopEnabled: true,
    browserEnabled: true,
    visualDesktopEnabled: true,
    intakeEnabled: true,
    ocrEnabled: true,
    disabledSkills: [],
    structuredOnlyClients: [],
    toolCatalog: { mode: "full", clients: [], coreTools: [...DEFAULT_TOOL_CATALOG_CORE_TOOLS] },
    documentTemplateTools: {},
    tunnelEnabled: false,
    openAiSecureTunnelEnabled: process.env.WORKSTATION_OPENAI_TUNNEL_ENABLED === "1",
    openAiSecureTunnelProfile: String(process.env.WORKSTATION_OPENAI_TUNNEL_PROFILE ?? "nhd-local"),
    openAiTunnelClientPath,
    tunnelMode: existsSync(namedTunnelConfig) ? "named" : "quick",
    namedTunnelName: "chatgpt-workstation-mcp",
    namedTunnelConfig,
    publicHostname: "",
    emergencyStop: false,
    pairingCode: randomBytes(4).toString("hex").toUpperCase(),
    companionSecret: process.env.WORKSTATION_COMPANION_SECRET ?? randomBytes(32).toString("hex"),
    cloudflaredPath: cloudflaredCandidates.find((path) => path === "cloudflared.exe" || existsSync(path)) ?? "cloudflared.exe",
  };
}

export function loadConfig(): AppConfig {
  const base = defaults();
  let stored: Partial<AppConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try { stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AppConfig>; } catch { stored = {}; }
  }
  const { pairingCode: _discardedStoredPairingCode, companionSecret: _discardedCompanionSecret, ...persisted } = stored;
  const config = { ...base, ...persisted, dataDir: DATA_DIR };
  const projectCloudflared = resolve(process.cwd(), "runtime", "cloudflared.exe");
  const configuredCloudflared = String(config.cloudflaredPath ?? "");
  if (existsSync(projectCloudflared) && !existsSync(configuredCloudflared)) config.cloudflaredPath = projectCloudflared;
  mkdirSync(config.backupDir, { recursive: true });
  saveConfig(config);
  return config;
}

export function saveConfig(config: AppConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const { pairingCode: _ephemeralPairingCode, companionSecret: _ephemeralCompanionSecret, ...persisted } = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2), { encoding: "utf8", mode: 0o600 });
}


