import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { cpus } from "node:os";
import { extname, resolve } from "node:path";
import type { FileService } from "./files.js";
import type { Store } from "./db.js";
import type { WorkspaceContextService } from "./workspace-memory.js";
import { resolveNhdPython } from "./python-runtime.js";

export type TurboMicroOp =
  | { kind: "file_stat"; path: string }
  | { kind: "file_read"; path: string; startLine?: number; endLine?: number; maxChars?: number }
  | { kind: "powershell_query"; command: string; cwd?: string }
  | { kind: "python_eval"; code: string }
  | { kind: "project_context"; root?: string; maxChars?: number; recentLimit?: number };

export type TurboDagNode = { id: string; dependsOn?: string[]; op: TurboMicroOp };

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; started: number };

type WorkerSpec = { name: string; command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv };

class NdjsonWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private ready = false;
  private starting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private stderr = "";
  private startedAt: string | null = null;
  private requests = 0;
  private failures = 0;
  private requestErrors = 0;
  private transportFailures = 0;
  private timeouts = 0;
  private consecutiveFailures = 0;
  private consecutiveTransportFailures = 0;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailureKind: "request" | "transport" | "timeout" | null = null;
  private lastFailureError: string | null = null;
  private lastRttMs: number | null = null;
  private pid: number | null = null;
  constructor(private readonly spec: WorkerSpec) {}
  private markSuccess() {
    this.consecutiveFailures = 0;
    this.consecutiveTransportFailures = 0;
    this.lastSuccessAt = new Date().toISOString();
  }
  private markFailure(kind: "request" | "transport" | "timeout", error: unknown) {
    this.failures += 1;
    this.consecutiveFailures += 1;
    if (kind === "request") this.requestErrors += 1;
    else {
      this.consecutiveTransportFailures += 1;
      if (kind === "transport") this.transportFailures += 1;
      else this.timeouts += 1;
    }
    this.lastFailureAt = new Date().toISOString();
    this.lastFailureKind = kind;
    this.lastFailureError = error instanceof Error ? error.message : String(error);
  }
  status() {
    const online = Boolean(this.child && this.ready && this.child.exitCode == null);
    return { name: this.spec.name, online, healthy: online && this.consecutiveTransportFailures === 0, pid: this.pid, startedAt: this.startedAt, requests: this.requests, failures: this.failures, requestErrors: this.requestErrors, transportFailures: this.transportFailures, timeouts: this.timeouts, consecutiveFailures: this.consecutiveFailures, consecutiveTransportFailures: this.consecutiveTransportFailures, lastSuccessAt: this.lastSuccessAt, lastFailureAt: this.lastFailureAt, lastFailureKind: this.lastFailureKind, lastFailureError: this.lastFailureError, pending: this.pending.size, lastRttMs: this.lastRttMs, stderrTail: this.stderr.slice(-500) };
  }
  async start(timeoutMs = 8000) {
    if (this.child && this.ready && this.child.exitCode == null) return;
    if (this.starting) return this.starting;
    this.starting = this.startInner(timeoutMs).finally(() => { this.starting = null; });
    return this.starting;
  }
  private async startInner(timeoutMs: number) {
    this.stop(new Error(`${this.spec.name} worker replaced before a new request was delivered.`));
    this.ready = false; this.buffer = ""; this.stderr = "";
    const child = spawn(this.spec.command, this.spec.args, { cwd: this.spec.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: this.spec.env ?? process.env });
    this.child = child; this.pid = child.pid ?? null; this.startedAt = new Date().toISOString();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-10000); });
    const startup = { error: null as Error | null };
    child.once("error", (error) => {
      startup.error = error;
      if (this.child !== child) return;
      this.child = null; this.ready = false; this.pid = null;
      this.markFailure("transport", error);
      this.stderr = (this.stderr + `\n${error.message}`).slice(-10000);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null; this.ready = false; this.pid = null;
      const error = new Error(`${this.spec.name} worker exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Pending commands are not replayed.`);
      this.markFailure("transport", error);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
    });
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (startup.error) throw new Error(`${this.spec.name} worker failed to start: ${startup.error.message}`);
      if (this.ready && this.child === child) return;
      if (child.exitCode != null) throw new Error(`${this.spec.name} worker exited before ready: ${this.stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 15));
    }
    this.stop(new Error(`${this.spec.name} worker readiness timeout.`));
    throw new Error(`${this.spec.name} worker did not become ready within ${timeoutMs} ms.`);
  }
  private consume(chunk: string) {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf("\n"); if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim(); this.buffer = this.buffer.slice(idx + 1); if (!line) continue;
      let msg: any; try { msg = JSON.parse(line); } catch { this.stderr = (this.stderr + `\n[stdout] ${line}`).slice(-10000); continue; }
      if (msg.kind === "ready") { this.ready = true; if (msg.pid) this.pid = Number(msg.pid); continue; }
      if (msg.kind !== "response") continue;
      const id = String(msg.id ?? ""); const p = this.pending.get(id); if (!p) continue;
      this.pending.delete(id); clearTimeout(p.timer); this.lastRttMs = Date.now() - p.started;
      if (msg.ok) { this.markSuccess(); p.resolve(msg); } else { const error = new Error(String(msg.error ?? msg.stderr ?? `${this.spec.name} worker request failed.`)); this.markFailure("request", error); p.reject(error); }
    }
  }
  async request(payload: Record<string, unknown>, timeoutMs = 10000) {
    await this.start();
    const child = this.child; if (!child || !this.ready) throw new Error(`${this.spec.name} worker is unavailable.`);
    const id = `${this.spec.name}-${randomBytes(10).toString("hex")}`; this.requests += 1;
    return new Promise<any>((resolvePromise, reject) => {
      const timer = setTimeout(() => { if (!this.pending.delete(id)) return; const error = new Error(`${this.spec.name} worker request timed out. The command is not replayed automatically.`); this.markFailure("timeout", error); reject(error); }, Math.max(500, Math.min(timeoutMs, 30000)));
      this.pending.set(id, { resolve: resolvePromise, reject, timer, started: Date.now() });
      child.stdin.write(JSON.stringify({ id, ...payload }) + "\n", "utf8", (error) => {
        if (!error) return; const p = this.pending.get(id); if (!p) return; this.pending.delete(id); clearTimeout(p.timer); const deliveryError = new Error(`${this.spec.name} worker write failed; delivery may be ambiguous and is not replayed: ${error.message}`); this.markFailure("transport", deliveryError);
        reject(deliveryError);
      });
    });
  }
  stop(reason = new Error(`${this.spec.name} worker stopped.`)) {
    const child = this.child; this.child = null; this.ready = false; this.pid = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear(); if (child && child.exitCode == null) { try { child.kill(); } catch {} }
  }
}

const SAFE_PS_FIRST = new Set(["get-date","get-item","get-childitem","get-child-item","test-path","resolve-path","get-content","get-process","get-ciminstance","measure-object","select-object","sort-object","select-string","convertto-json","convertfrom-json"]);
const PS_BLOCK = /(?:^|[\s|])(set-|new-|remove-|rename-|move-|copy-|add-|clear-|start-|stop-|restart-|enable-|disable-|invoke-|import-|export-|out-file|tee-object|write-output\s*>|curl\b|wget\b|iwr\b|irm\b|cmd\b|powershell\b|pwsh\b|python\b|node\b|git\b|taskkill\b|reg\b|sc\b|net\b)|[;&>`]|::|\$\(|\[scriptblock\]/i;
export function isTurboSafePowerShell(command: string) {
  const text = String(command ?? "").trim(); if (!text || text.length > 4000 || /[\r\n]/.test(text) || PS_BLOCK.test(text)) return false;
  const first = text.split(/[\s|]/, 1)[0].toLowerCase(); return SAFE_PS_FIRST.has(first);
}

export class BackgroundTurboService {
  readonly maxConcurrency: number;
  private readonly psWorkers: NdjsonWorker[];
  private readonly pyWorker: NdjsonWorker;
  private rr = 0;
  private projectCache = new Map<string, { at: number; value: unknown }>();
  private metricsState = { microCalls: 0, dagRuns: 0, batchRuns: 0, projectCacheHits: 0, projectCacheMisses: 0, artifactHandles: 0, psFastCalls: 0, pyCalls: 0 };
  constructor(readonly store: Store, readonly files: FileService, readonly workspaceMemory?: WorkspaceContextService, root = process.cwd()) {
    const cpuCount = Math.max(1, cpus().length); this.maxConcurrency = Math.max(2, Math.min(Number(process.env.NHD_BACKGROUND_CONCURRENCY ?? Math.floor(cpuCount / 2)), 6));
    const psCount = Math.max(1, Math.min(Number(process.env.NHD_BACKGROUND_PS_WORKERS ?? 2), 4));
    const psScript = resolve(root, "workers", "background-powershell-worker.ps1");
    const safeEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    this.psWorkers = Array.from({ length: psCount }, (_, i) => new NdjsonWorker({ name: `ps${i+1}`, command: "powershell.exe", args: ["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","RemoteSigned","-File",psScript], cwd: root, env: safeEnv }));
    this.pyWorker = new NdjsonWorker({ name: "python", command: resolveNhdPython(), args: [resolve(root,"workers","background-python-worker.py")], cwd: root, env: safeEnv });
  }
  async prewarm() { await Promise.all([...this.psWorkers.map((w) => w.start()), this.pyWorker.start()]); return this.status(); }
  stop() { for (const w of this.psWorkers) w.stop(); this.pyWorker.stop(); }
  status() { return { available: true, version: "1.0.0", mode: "background-turbo", maxConcurrency: this.maxConcurrency, microFastLane: true, dagScheduler: true, zeroCopyArtifacts: true, projectHotCache: { entries: this.projectCache.size, ttlMs: 2500 }, workers: { powershell: this.psWorkers.map((w) => w.status()), python: this.pyWorker.status() }, metrics: { ...this.metricsState }, fileCache: typeof (this.files as any).cacheStatus === "function" ? (this.files as any).cacheStatus() : { available: false } }; }
  async execPowerShellQuery(command: string, cwd = "D:\\") {
    if (!isTurboSafePowerShell(command)) throw new Error("Background Turbo PowerShell fast path accepts only bounded read-only query commands; use normal Terminal preview/apply for anything else.");
    const safeCwd = this.files.resolvePath(cwd); const worker = this.psWorkers[this.rr++ % this.psWorkers.length]; this.metricsState.psFastCalls += 1;
    const response = await worker.request({ cwd: safeCwd, commandBase64: Buffer.from(command,"utf8").toString("base64") }, 10000);
    return { code: Number(response.code ?? 0), stdout: String(response.stdout ?? "").slice(0,1_000_000), stderr: String(response.stderr ?? "").slice(0,100_000), elapsedMs: Number(response.elapsedMs ?? 0), workerPid: response.pid ?? null, turbo: true };
  }
  async pythonEval(code: string) { this.metricsState.pyCalls += 1; const response = await this.pyWorker.request({ code }, 10000); return { result: response.result ?? null, locals: response.locals ?? {}, elapsedMs: Number(response.elapsedMs ?? 0), turbo: true }; }
  async projectContext(root?: string, maxChars = 12000, recentLimit = 5) {
    if (!this.workspaceMemory) throw new Error("Workspace memory is unavailable."); const key = `${root ?? "*"}|${maxChars}|${recentLimit}`; const hit = this.projectCache.get(key);
    if (hit && Date.now() - hit.at <= 2500) { this.metricsState.projectCacheHits += 1; return { cacheHit: true, value: hit.value }; }
    this.metricsState.projectCacheMisses += 1; const value = this.workspaceMemory.bootstrap(root, { maxChars: Math.max(2000,Math.min(maxChars,50000)), recentLimit: Math.max(1,Math.min(recentLimit,20)), activate: false }); this.projectCache.set(key,{at:Date.now(),value}); return { cacheHit:false,value };
  }
  invalidateProject(root?: string) { if (!root) this.projectCache.clear(); else for (const key of [...this.projectCache.keys()]) if (key.startsWith(`${root}|`)) this.projectCache.delete(key); }
  async runMicro(op: TurboMicroOp) {
    this.metricsState.microCalls += 1;
    if (op.kind === "file_stat") return this.files.stat(op.path);
    if (op.kind === "file_read") return { path: this.files.resolvePath(op.path), text: this.files.read(op.path, op.startLine ?? 1, op.endLine ?? 400, op.maxChars ?? 100000) };
    if (op.kind === "powershell_query") return this.execPowerShellQuery(op.command, op.cwd ?? "D:\\");
    if (op.kind === "python_eval") return this.pythonEval(op.code);
    return this.projectContext(op.root, op.maxChars, op.recentLimit);
  }
  async runBatch(ops: TurboMicroOp[], concurrency = this.maxConcurrency) { this.metricsState.batchRuns += 1; const nodes = ops.map((op,i)=>({id:`op${i+1}`,op})); return this.runDag(nodes,concurrency); }
  async runDag(nodes: TurboDagNode[], concurrency = this.maxConcurrency) {
    this.metricsState.dagRuns += 1; if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 100) throw new Error("Background DAG requires 1-100 nodes.");
    const ids = new Set(nodes.map((n)=>n.id)); if (ids.size !== nodes.length || [...ids].some((id)=>!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id))) throw new Error("Background DAG node ids must be unique bounded identifiers.");
    for (const n of nodes) for (const d of n.dependsOn ?? []) if (!ids.has(d)) throw new Error(`Unknown dependency '${d}' for node '${n.id}'.`);
    const max = Math.max(1,Math.min(Math.floor(concurrency),this.maxConcurrency)); const pending = new Map(nodes.map((n)=>[n.id,n])); const running = new Map<string,Promise<void>>(); const results: Record<string,unknown> = {}; const startedAt = Date.now();
    const launch = (node: TurboDagNode) => { const p=(async()=>{ results[node.id]=await this.runMicro(node.op); })().finally(()=>running.delete(node.id)); running.set(node.id,p); pending.delete(node.id); };
    while (pending.size || running.size) {
      let progressed=false;
      for (const node of [...pending.values()]) { if (running.size>=max) break; if ((node.dependsOn??[]).every((d)=>Object.prototype.hasOwnProperty.call(results,d))) { launch(node); progressed=true; } }
      if (!running.size && pending.size) throw new Error("Background DAG contains a dependency cycle.");
      if (running.size) await Promise.race(running.values()); else if (!progressed) break;
    }
    return { ok:true, elapsedMs:Date.now()-startedAt, concurrency:max, results };
  }
  artifactHandle(pathInput: string) {
    const path = this.files.resolvePath(pathInput); if (!existsSync(path) || !statSync(path).isFile()) throw new Error("Artifact handle requires an existing regular file.");
    const stat = this.files.stat(path); const hash = String((stat as any).hash ?? ""); const handle = `artifact:sha256:${hash}`; this.metricsState.artifactHandles += 1;
    return { handle, path, hash, size:(stat as any).size, modifiedAt:(stat as any).modifiedAt, extension:extname(path).toLowerCase(), zeroCopy:true };
  }
  static fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
}
