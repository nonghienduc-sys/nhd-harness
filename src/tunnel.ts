import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";

type SpawnTunnelProcess = (command: string, args: string[], options: { windowsHide: boolean }) => ChildProcessWithoutNullStreams;

type TunnelServiceOptions = {
  spawnProcess?: SpawnTunnelProcess;
  restartDelaysMs?: number[];
  stableResetMs?: number;
};

export class TunnelService {
  private process: ChildProcessWithoutNullStreams | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private outputTail = "";
  private desiredRunning = false;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRestartAt: string | null = null;
  private connectedAt: string | null = null;
  private readonly spawnProcess: SpawnTunnelProcess;
  private readonly restartDelaysMs: number[];
  private readonly stableResetMs: number;

  constructor(readonly config: AppConfig, readonly store: Store, options: TunnelServiceOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.restartDelaysMs = options.restartDelaysMs?.length ? options.restartDelaysMs : [2000, 5000, 10000, 30000, 60000, 120000, 300000];
    this.stableResetMs = options.stableResetMs ?? 10 * 60 * 1000;
  }

  start() {
    this.desiredRunning = true;
    this.clearRestartTimer();
    if (this.process) return this.status();
    this.restartAttempt = 0;
    this.lastError = null;
    this.outputTail = "";
    return this.launch();
  }

  private launch() {
    if (!this.desiredRunning || !this.config.tunnelEnabled || this.config.emergencyStop) return this.status();
    if (this.process) return this.status();

    const named = this.config.tunnelMode === "named";
    if (named && !existsSync(this.config.namedTunnelConfig)) {
      this.lastError = `Named tunnel config was not found: ${this.config.namedTunnelConfig}`;
      this.store.audit("tunnel", "start_failed", { error: this.lastError });
      this.scheduleRestart();
      return this.status();
    }

    const args = named
      ? ["tunnel", "--no-autoupdate", "--config", this.config.namedTunnelConfig, "run", this.config.namedTunnelName]
      : ["tunnel", "--no-autoupdate", "--url", `http://${this.config.host}:${this.config.port}`];

    if (named) this.url = `https://${this.config.publicHostname}`;
    this.outputTail = "";
    this.connectedAt = null;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(this.config.cloudflaredPath, args, { windowsHide: true });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.store.audit("tunnel", "spawn_failed", { error: this.lastError, path: this.config.cloudflaredPath });
      this.scheduleRestart();
      return this.status();
    }

    this.process = child;
    this.store.audit("tunnel", "started", { pid: child.pid ?? null, mode: this.config.tunnelMode, attempt: this.restartAttempt, path: this.config.cloudflaredPath });

    const inspect = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.appendOutput(text);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        this.url = match[0];
        this.markConnected("quick");
      }
      if (named && /registered tunnel connection/i.test(text)) this.markConnected("named");
      if (/\bFTL\b|failed to start|authentication failed|credentials.*not found|unable to start tunnel/i.test(text)) {
        this.lastError = text.slice(-2000);
      }
    };

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("close", (code, signal) => {
      if (this.process === child) this.process = null;
      this.clearStableTimer();
      this.connectedAt = null;
      this.url = null;
      const tail = this.outputTail.slice(-4000);
      if (this.desiredRunning && this.config.tunnelEnabled && !this.config.emergencyStop) {
        this.lastError = tail || `cloudflared exited with code ${String(code)}${signal ? ` (${signal})` : ""}`;
      }
      this.store.audit("tunnel", "stopped", {
        code,
        signal,
        desiredRunning: this.desiredRunning,
        restartAttempt: this.restartAttempt,
        outputTail: tail || null,
      });
      this.scheduleRestart();
    });
    child.on("error", (error) => {
      if (this.process === child) this.process = null;
      this.clearStableTimer();
      this.connectedAt = null;
      this.lastError = error.message;
      this.store.audit("tunnel", "process_error", { error: error.message, restartAttempt: this.restartAttempt });
      this.scheduleRestart();
    });

    return this.status();
  }

  private appendOutput(text: string) {
    this.outputTail = `${this.outputTail}${text}`.slice(-8000);
  }

  private markConnected(mode: "quick" | "named") {
    const firstConnection = this.connectedAt == null;
    this.connectedAt = new Date().toISOString();
    this.lastError = null;
    if (firstConnection) this.store.audit("tunnel", "connected", { url: this.url, mode, attempt: this.restartAttempt });
    this.clearStableTimer();
    const child = this.process;
    this.stableTimer = setTimeout(() => {
      if (this.process !== child || !this.connectedAt) return;
      if (this.restartAttempt > 0) this.store.audit("tunnel", "stable", { stableForMs: this.stableResetMs, previousRestartAttempt: this.restartAttempt });
      this.restartAttempt = 0;
      this.stableTimer = null;
    }, this.stableResetMs);
  }

  private scheduleRestart() {
    if (!this.desiredRunning || !this.config.tunnelEnabled || this.config.emergencyStop || this.process || this.restartTimer) return;
    const index = Math.min(this.restartAttempt, this.restartDelaysMs.length - 1);
    const delayMs = this.restartDelaysMs[index];
    this.restartAttempt += 1;
    this.nextRestartAt = new Date(Date.now() + delayMs).toISOString();
    this.store.audit("tunnel", "restart_scheduled", { attempt: this.restartAttempt, delayMs, nextRestartAt: this.nextRestartAt });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.nextRestartAt = null;
      if (!this.desiredRunning || !this.config.tunnelEnabled || this.config.emergencyStop) return;
      this.launch();
    }, delayMs);
  }

  private clearRestartTimer() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.nextRestartAt = null;
  }

  private clearStableTimer() {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  stop() {
    this.desiredRunning = false;
    this.clearRestartTimer();
    this.clearStableTimer();
    const child = this.process;
    this.process = null;
    this.url = null;
    this.connectedAt = null;
    if (child) {
      try { child.kill(); } catch { /* process may already be gone */ }
    }
    this.store.audit("tunnel", "stop_requested", {});
    return this.status();
  }

  status() {
    return {
      running: Boolean(this.process),
      desiredRunning: this.desiredRunning,
      mode: this.config.tunnelMode,
      pid: this.process?.pid ?? null,
      url: this.url,
      mcpUrl: this.url ? `${this.url}/mcp` : null,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      restartAttempt: this.restartAttempt,
      restartScheduled: Boolean(this.restartTimer),
      nextRestartAt: this.nextRestartAt,
      cloudflaredPath: this.config.cloudflaredPath,
    };
  }
}
