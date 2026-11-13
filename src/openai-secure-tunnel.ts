import { spawn, execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { Store } from "./db.js";

type PersistedState = { pid: number | null; startedAt: string | null; lastError: string | null; profile: string; updatedAt: string };

function redact(text: string) {
  return String(text || "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]").slice(-12000);
}

export class OpenAISecureTunnelService {
  readonly statePath: string;
  readonly logPath: string;
  private state: PersistedState;

  constructor(readonly config: AppConfig, readonly store: Store) {
    this.statePath = resolve(config.dataDir, "openai-secure-tunnel-status.json");
    this.logPath = resolve(config.dataDir, "logs", "openai-secure-tunnel.log");
    this.state = { pid: null, startedAt: null, lastError: null, profile: config.openAiSecureTunnelProfile, updatedAt: new Date().toISOString() };
    this.load();
  }

  private load() {
    try {
      if (!existsSync(this.statePath)) return;
      const saved = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState;
      if (saved && typeof saved === "object") this.state = { ...this.state, ...saved, profile: this.config.openAiSecureTunnelProfile };
    } catch {}
  }

  private save() {
    this.state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private isAlive(pid = this.state.pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  private binaryInstalled() {
    return existsSync(this.config.openAiTunnelClientPath);
  }

  status() {
    const running = this.isAlive();
    if (!running && this.state.pid) {
      this.state.pid = null;
      this.state.startedAt = null;
      this.save();
    }
    const binaryInstalled = this.binaryInstalled();
    const runtimeKeyPresent = Boolean(process.env.CONTROL_PLANE_API_KEY);
    return {
      available: true,
      provider: "openai",
      product: "Secure MCP Tunnel",
      lifecycle: "external-detached-client-v1",
      desiredRunning: this.config.openAiSecureTunnelEnabled,
      running,
      pid: running ? this.state.pid : null,
      startedAt: running ? this.state.startedAt : null,
      profile: this.config.openAiSecureTunnelProfile,
      binaryPath: this.config.openAiTunnelClientPath,
      binaryInstalled,
      runtimeKeyPresent,
      configured: binaryInstalled && Boolean(this.config.openAiSecureTunnelProfile),
      setupRequired: !binaryInstalled || !runtimeKeyPresent,
      targetUrl: `http://127.0.0.1:${this.config.localHarnessPort}/mcp`,
      publicExposure: false,
      domainRequired: false,
      controlPlane: "api.openai.com:443",
      docsUrl: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
      lastError: this.state.lastError,
      logPath: this.logPath,
      secretsPersistedByNhd: false,
    };
  }

  async start() {
    if (this.config.emergencyStop) throw new Error("Emergency stop is enabled.");
    if (this.isAlive()) return this.status();
    if (!this.binaryInstalled()) throw new Error(`OpenAI tunnel-client is not installed at ${this.config.openAiTunnelClientPath}`);
    if (!process.env.CONTROL_PLANE_API_KEY) throw new Error("CONTROL_PLANE_API_KEY is not available in the MCP runtime environment.");
    mkdirSync(dirname(this.logPath), { recursive: true });
    const fd = openSync(this.logPath, "a");
    try {
      const child = spawn(this.config.openAiTunnelClientPath, ["run", "--profile", this.config.openAiSecureTunnelProfile], {
        cwd: process.cwd(), detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env: { ...process.env },
      });
      this.state.pid = child.pid ?? null;
      this.state.startedAt = new Date().toISOString();
      this.state.lastError = null;
      this.state.profile = this.config.openAiSecureTunnelProfile;
      this.save();
      child.unref();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      if (!this.isAlive()) {
        this.state.pid = null; this.state.startedAt = null; this.state.lastError = "tunnel-client exited during startup. Check the OpenAI tunnel log and run doctor."; this.save();
        throw new Error(this.state.lastError);
      }
      this.store.audit("openai_secure_tunnel", "started", { pid: this.state.pid, profile: this.config.openAiSecureTunnelProfile, targetUrl: `http://127.0.0.1:${this.config.localHarnessPort}/mcp` });
      return this.status();
    } finally { closeSync(fd); }
  }

  async stop() {
    const pid = this.state.pid;
    if (this.isAlive(pid)) {
      try { process.kill(pid!, "SIGTERM"); } catch {}
    }
    this.state.pid = null; this.state.startedAt = null; this.save();
    this.store.audit("openai_secure_tunnel", "stopped", { pid, profile: this.config.openAiSecureTunnelProfile });
    return this.status();
  }

  doctor(timeoutMs = 15_000) {
    if (!this.binaryInstalled()) return Promise.reject(new Error(`OpenAI tunnel-client is not installed at ${this.config.openAiTunnelClientPath}`));
    return new Promise<{ ok: boolean; profile: string; output: string }>((resolvePromise, reject) => {
      execFile(this.config.openAiTunnelClientPath, ["doctor", "--profile", this.config.openAiSecureTunnelProfile, "--explain"], { windowsHide: true, timeout: timeoutMs, env: { ...process.env } }, (error, stdout, stderr) => {
        const output = redact(`${stdout || ""}\n${stderr || ""}`.trim());
        if (error) return reject(new Error(output || error.message));
        resolvePromise({ ok: true, profile: this.config.openAiSecureTunnelProfile, output });
      });
    });
  }

  async ensureStarted() {
    if (!this.config.openAiSecureTunnelEnabled || this.config.emergencyStop || this.isAlive()) return this.status();
    return this.start();
  }

  close() {
    // Intentionally preserve the detached OpenAI tunnel-client across backend restarts.
  }
}
