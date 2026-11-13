import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";

type SupervisorStatus = {
  running: boolean;
  desiredRunning: boolean;
  mode: "quick" | "named";
  pid: number | null;
  url: string | null;
  mcpUrl: string | null;
  lastError: string | null;
  connectedAt: string | null;
  restartAttempt: number;
  restartScheduled: boolean;
  nextRestartAt: string | null;
  cloudflaredPath: string;
  instanceId?: string;
  lifecycle?: string;
  supervisor?: { running?: boolean; pid?: number | null; startedAt?: string | null; controlPort?: number | null };
  updatedAt?: string | null;
};

function sleep(ms: number) { return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms)); }

export class TunnelSupervisorClient {
  private cache: SupervisorStatus;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ensurePromise: Promise<void> | null = null;
  readonly controlPort: number;
  readonly statusPath: string;

  constructor(readonly config: AppConfig, readonly store: Store) {
    this.controlPort = Number(process.env.WORKSTATION_TUNNEL_SUPERVISOR_PORT ?? (config.port + 3));
    this.statusPath = resolve(config.dataDir, "tunnel-supervisor-status.json");
    const namedUrl = config.tunnelMode === "named" && config.publicHostname ? `https://${config.publicHostname}` : null;
    this.cache = {
      running: false,
      desiredRunning: config.tunnelEnabled,
      mode: config.tunnelMode,
      pid: null,
      url: namedUrl,
      mcpUrl: namedUrl ? `${namedUrl}/mcp` : null,
      lastError: null,
      connectedAt: null,
      restartAttempt: 0,
      restartScheduled: false,
      nextRestartAt: null,
      cloudflaredPath: config.cloudflaredPath,
      instanceId: config.instanceId,
      lifecycle: "external-supervisor-v1",
      supervisor: { running: false, pid: null, startedAt: null, controlPort: this.controlPort },
      updatedAt: null,
    };
    this.loadStatusFile();
  }

  private loadStatusFile() {
    if (!existsSync(this.statusPath)) return;
    try {
      const value = JSON.parse(readFileSync(this.statusPath, "utf8")) as SupervisorStatus;
      if (value?.instanceId && value.instanceId !== this.config.instanceId) return;
      if (value && typeof value.running === "boolean") this.cache = { ...this.cache, ...value };
    } catch {}
  }

  private headers() {
    return { "x-workstation-companion-secret": String(this.config.companionSecret || "") };
  }

  private async request(path: string, method: "GET" | "POST" = "GET", timeoutMs = 1800): Promise<SupervisorStatus> {
    const response = await fetch(`http://127.0.0.1:${this.controlPort}${path}`, {
      method,
      headers: this.headers(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({})) as SupervisorStatus & { error?: string };
    if (!response.ok) throw new Error(body.error || `Tunnel supervisor HTTP ${response.status}`);
    if (body?.instanceId && body.instanceId !== this.config.instanceId) throw new Error("Tunnel supervisor instance mismatch.");
    this.cache = { ...this.cache, ...body };
    return this.cache;
  }

  private async reachable() {
    try { await this.request("/status", "GET", 700); return true; }
    catch { return false; }
  }

  private async ensureSupervisor() {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = (async () => {
      if (await this.reachable()) return;
      const script = resolve(process.cwd(), "dist", "tunnel-supervisor.js");
      if (!existsSync(script)) throw new Error(`Tunnel supervisor runtime is missing: ${script}`);
      const child = spawn(process.execPath, [script], {
        cwd: process.cwd(),
        windowsHide: true,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          WORKSTATION_MCP_DATA_DIR: this.config.dataDir,
          WORKSTATION_COMPANION_SECRET: String(this.config.companionSecret || ""),
          WORKSTATION_TUNNEL_SUPERVISOR_PORT: String(this.controlPort),
        },
      });
      child.unref();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(125);
        if (await this.reachable()) {
          this.store.audit("tunnel_supervisor", "attached", { supervisorPid: this.cache.supervisor?.pid ?? null, controlPort: this.controlPort });
          return;
        }
      }
      throw new Error("Tunnel supervisor did not become ready within 5 seconds.");
    })().finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }

  private startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.refresh().catch(async (error) => {
        this.cache.lastError = error instanceof Error ? error.message : String(error);
        this.cache.supervisor = { ...(this.cache.supervisor ?? {}), running: false, controlPort: this.controlPort };
        if (!this.config.tunnelEnabled || this.config.emergencyStop) return;
        try {
          await this.ensureSupervisor();
          await this.request("/start", "POST", 2500);
        } catch {}
      });
    }, 3000);
    this.pollTimer.unref?.();
  }

  private fallbackStopFromFreshStatus() {
    try {
      this.loadStatusFile();
      const updated = this.cache.updatedAt ? new Date(this.cache.updatedAt).getTime() : 0;
      const fresh = Number.isFinite(updated) && Date.now() - updated < 60_000;
      const pid = Number(this.cache.pid);
      if (fresh && Number.isInteger(pid) && pid > 0) {
        process.kill(pid, "SIGTERM");
        this.store.audit("tunnel_supervisor", "fallback_tunnel_stop", { pid, reason: "supervisor_unreachable" });
      }
    } catch {}
  }

  async start() {
    this.config.tunnelEnabled = true;
    await this.ensureSupervisor();
    const status = await this.request("/start", "POST", 3000);
    this.startPolling();
    return status;
  }

  async stop() {
    this.config.tunnelEnabled = false;
    try {
      if (await this.reachable()) await this.request("/stop", "POST", 3000);
      else this.fallbackStopFromFreshStatus();
    } catch (error) {
      this.fallbackStopFromFreshStatus();
      this.cache.lastError = error instanceof Error ? error.message : String(error);
    }
    this.cache.running = false;
    this.cache.desiredRunning = false;
    this.cache.connectedAt = null;
    this.cache.pid = null;
    return this.status();
  }

  async refresh() {
    const status = await this.request("/status", "GET", 1800);
    this.startPolling();
    return status;
  }

  close() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  status() {
    this.loadStatusFile();
    return { ...this.cache, lifecycle: "external-supervisor-v1" };
  }
}
