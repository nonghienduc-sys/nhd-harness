import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";

export type PersistentJsonWorkerStatus = {
  name: string;
  online: boolean;
  pid: number | null;
  startedAt: string | null;
  requests: number;
  failures: number;
  pending: number;
  lastRttMs: number | null;
  startupMs: number | null;
  stderrTail: string;
};

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  started: number;
};

/**
 * Bounded NDJSON request/response worker. Transport failures never replay a
 * request automatically. Callers may explicitly fall back to a one-shot path
 * only when the operation is pure/read-only.
 */
export class PersistentJsonWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  private buffer = "";
  private stderr = "";
  private pending = new Map<string, Pending>();
  private requests = 0;
  private failures = 0;
  private lastRttMs: number | null = null;
  private startupMs: number | null = null;
  private pid: number | null = null;
  private startedAt: string | null = null;

  constructor(
    readonly name: string,
    readonly executable: string,
    readonly args: string[],
    readonly cwd = process.cwd(),
  ) {}

  status(): PersistentJsonWorkerStatus {
    return {
      name: this.name,
      online: Boolean(this.child && this.ready && this.child.exitCode == null),
      pid: this.pid,
      startedAt: this.startedAt,
      requests: this.requests,
      failures: this.failures,
      pending: this.pending.size,
      lastRttMs: this.lastRttMs,
      startupMs: this.startupMs,
      stderrTail: this.stderr.slice(-1000),
    };
  }

  async start(timeoutMs = 30_000) {
    if (this.child && this.ready && this.child.exitCode == null) return;
    if (this.starting) return this.starting;
    this.starting = this.startInner(timeoutMs).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startInner(timeoutMs: number) {
    this.stop(new Error(`${this.name} worker replaced before a new request was delivered.`));
    const t0 = Date.now();
    this.ready = false;
    this.buffer = "";
    this.stderr = "";
    const child = spawn(this.executable, this.args, {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.pid = child.pid ?? null;
    this.startedAt = new Date().toISOString();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-20_000); });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.pid = null;
      const error = new Error(`${this.name} persistent worker exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Pending requests are not replayed automatically.`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.stderr = (this.stderr + `\n${error.message}`).slice(-20_000);
    });
    while (Date.now() - t0 < timeoutMs) {
      if (this.ready && this.child === child) {
        this.startupMs = Date.now() - t0;
        return;
      }
      if (child.exitCode != null) throw new Error(`${this.name} worker exited before ready: ${this.stderr.slice(-2000)}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    }
    this.stop(new Error(`${this.name} worker readiness timeout.`));
    throw new Error(`${this.name} worker did not become ready within ${timeoutMs} ms.`);
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); }
      catch {
        this.stderr = (this.stderr + `\n[stdout] ${line}`).slice(-20_000);
        continue;
      }
      if (message.kind === "ready") {
        this.ready = true;
        this.pid = Number(message.pid || this.pid) || this.pid;
        continue;
      }
      if (message.kind !== "response") continue;
      const id = String(message.id || "");
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      this.lastRttMs = Date.now() - pending.started;
      if (message.ok) pending.resolve((message.result ?? {}) as Record<string, unknown>);
      else {
        this.failures += 1;
        pending.reject(new Error(String(message.error || `${this.name} worker request failed.`)));
      }
    }
  }

  async request(payload: Record<string, unknown>, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    await this.start();
    const child = this.child;
    if (!child || !this.ready) throw new Error(`${this.name} persistent worker is unavailable.`);
    const id = `${this.name}-${randomBytes(10).toString("hex")}`;
    this.requests += 1;
    return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.failures += 1;
        reject(new Error(`${this.name} worker request timed out. The request is not replayed automatically.`));
      }, Math.max(1000, Math.min(timeoutMs, 600_000)));
      this.pending.set(id, { resolve: resolvePromise, reject, timer, started: Date.now() });
      child.stdin.write(JSON.stringify({ id, payload }) + "\n", "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        this.failures += 1;
        reject(new Error(`${this.name} worker transport write failed; delivery may be ambiguous and is not replayed: ${error.message}`));
      });
    });
  }

  stop(reason = new Error(`${this.name} worker stopped.`)) {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.pid = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    if (child && child.exitCode == null) {
      try { child.kill(); } catch {}
    }
  }
}
