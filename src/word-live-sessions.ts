/**
 * Path-scoped Word Live sessions. The legacy (no-path) Office worker is untouched.
 * Every path-scoped session owns exactly one PowerShell worker and one independently
 * created WINWORD process. No process is terminated by image name.
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export type WordSessionOptions = {
  path: string;
  read_only?: boolean;
  remove_stale_lock?: boolean;
  timeout_ms?: number;
};
export type WordSessionRecord = {
  path: string; workerPid: number; pid: number; started: string;
  openedAt: string; lastUsedAt: string; ownerPid: number; ownerId: string; readOnly: boolean;
};
type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Session = {
  key: string; path: string; worker: ChildProcessWithoutNullStreams;
  buffer: string; stderr: string; record?: WordSessionRecord;
  readOnly: boolean; staleLock: boolean; stopped: boolean; abandonedMutexRecovered: boolean;
  pending: Map<string, Pending>; tail: Promise<unknown>;
};
export function normalizeWordPath(path: string): string {
  if (!isAbsolute(path) || extname(path).toLowerCase() !== ".docx") throw new Error("WORD_LIVE_INVALID_PATH: absolute .docx required");
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error("WORD_LIVE_INVALID_PATH: file not found");
  return realpathSync.native(absolute);
}
export function keyForWordPath(path: string): string { return normalizeWordPath(path).toLocaleLowerCase("en-US"); }
export function wordLockCandidates(path: string): string[] {
  const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  const folder = dirname(path);
  return [...new Set([join(folder, "~$" + name.slice(2)), join(folder, "~$" + name)])];
}
export function hasPotentialWordLock(path: string): boolean { return wordLockCandidates(path).some(existsSync); }
export function verifiedOrphans(registry: WordSessionRecord[], live: Array<{ pid: number; name: string; started: string }>, liveOwners: Set<number>): WordSessionRecord[] {
  return registry.filter(entry =>
    entry && !liveOwners.has(entry.ownerPid) &&
    live.some(p => p.pid === entry.pid && p.name.toUpperCase() === "WINWORD" && p.started === entry.started)
  );
}
function delay(ms: number) { return new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms)); }
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function powershell(command: string, timeout = 7000): Promise<string> {
  return new Promise((res, rej) => execFile("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
    (error, out) => error ? rej(error) : res(String(out).trim())));
}
async function getProcessIdentity(pid: number): Promise<{ pid: number; name: string; started: string } | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const script = '$p=Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if($p){[pscustomobject]@{pid=[int]$p.Id;name=[string]$p.ProcessName;started=$p.StartTime.ToUniversalTime().ToString("o")}|ConvertTo-Json -Compress}';
  try { const out = await powershell(script); return out ? JSON.parse(out) : null; } catch { return null; }
}
export async function stopVerifiedWordProcess(record: Pick<WordSessionRecord, "pid" | "started">): Promise<boolean> {
  const identity = await getProcessIdentity(record.pid);
  if (!identity || identity.name.toUpperCase() !== "WINWORD" || identity.started !== record.started) return false;
  // Revalidate in the same PowerShell invocation before kill to prevent PID reuse races.
  const safeDate = JSON.stringify(record.started);
  const cmd = '$p=Get-Process -Id ' + Number(record.pid) + ' -ErrorAction SilentlyContinue; if($p -and $p.ProcessName -eq "WINWORD" -and $p.StartTime.ToUniversalTime().ToString("o") -eq ' + safeDate + '){Stop-Process -Id ' + Number(record.pid) + ' -Force; "stopped"}';
  try {
    return (await powershell(cmd)).includes("stopped");
  } catch (error) {
    // Word may have quit naturally after the first identity probe.
    // Never mistake that race for an unsuccessful cleanup.
    const after = await getProcessIdentity(record.pid);
    if (!after || after.name.toUpperCase() !== "WINWORD" || after.started !== record.started) return false;
    throw error; // Still the same owned process: preserve its registry entry for recovery.
  }
}

export class WordLiveSessionPool {
  readonly maxInstances: number;
  readonly idleMs: number;
  readonly registryPath: string;
  private readonly ownerId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session>>();
  private readonly inflight = new Set<Session>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private lastOrphanSweep = 0;
  private readonly workerPath: string;
  private readonly bridgePath: string;
  private readonly externalWordDocuments?: () => Promise<string[]>;
  private readonly workerEnv?: Record<string, string>;

  constructor(options: { maxInstances?: number; idleMs?: number; registryPath?: string; workerPath?: string; bridgePath?: string; externalWordDocuments?: () => Promise<string[]>; workerEnv?: Record<string, string> } = {}) {
    this.maxInstances = Math.max(1, Math.min(32, Number(options.maxInstances ?? process.env.NHD_WORD_LIVE_MAX_INSTANCES ?? 4) || 4));
    this.idleMs = Math.max(1000, Number(options.idleMs ?? process.env.NHD_WORD_LIVE_IDLE_MS ?? 600000) || 600000);
    this.registryPath = options.registryPath ?? join(process.env.LOCALAPPDATA || process.env.TEMP || ".", "nhd-harness", "word-live-sessions.json");
    this.workerPath = options.workerPath ?? resolve(process.cwd(), "office", "word-session-worker.ps1");
    this.bridgePath = options.bridgePath ?? resolve(process.cwd(), "office", "office-bridge.ps1");
    this.externalWordDocuments = options.externalWordDocuments;
    this.workerEnv = options.workerEnv;
    this.timer = setInterval(() => { void this.reapIdle(); }, Math.max(1000, Math.min(30000, this.idleMs / 2)));
    this.timer.unref();
  }
  private readRegistry(): WordSessionRecord[] {
    try {
      const list: unknown = JSON.parse(readFileSync(this.registryPath, "utf8"));
      return Array.isArray(list) ? list.filter((e): e is WordSessionRecord => !!e && typeof e === "object" && typeof e.pid === "number" && typeof e.started === "string") : [];
    } catch { return []; }
  }
  private writeRegistry() {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const own = this.list();
    const foreign = this.readRegistry().filter(item => !(item.ownerPid === process.pid && item.ownerId === this.ownerId));
    const temp = this.registryPath + "." + this.ownerId + ".tmp";
    writeFileSync(temp, JSON.stringify([...foreign, ...own], null, 2), "utf8");
    renameSync(temp, this.registryPath);
  }
  private removeRegistryEntry(record: WordSessionRecord) {
    mkdirSync(dirname(this.registryPath), { recursive: true });
    const kept = this.readRegistry().filter(item => !(item.pid === record.pid && item.started === record.started && item.ownerId === record.ownerId));
    const temp = this.registryPath + "." + this.ownerId + ".tmp";
    writeFileSync(temp, JSON.stringify(kept, null, 2), "utf8"); renameSync(temp, this.registryPath);
  }
  list(): WordSessionRecord[] {
    return [...new Set([...this.sessions.values(), ...this.inflight])]
      .flatMap(s => s.record ? [s.record] : []);
  }
  async cleanupOrphans(): Promise<number> {
    let killed = 0;
    const entries = this.readRegistry();
    for (const entry of entries) {
      if (!entry || entry.ownerPid === process.pid && entry.ownerId === this.ownerId) continue;
      const owner = await getProcessIdentity(entry.ownerPid);
      if (owner) continue; // Another live harness still owns this session; never touch it.
      if (await stopVerifiedWordProcess(entry)) killed++;
      this.removeRegistryEntry(entry);
    }
    return killed;
  }
  private async launch(path: string, key: string, opts: WordSessionOptions): Promise<Session> {
    // Inspect the user-visible Word instance via the legacy read-only bridge,
    // before creating a new COM instance. The path worker never uses ROT/ActiveObject.
    if (this.externalWordDocuments) {
      const opened = await bounded(this.externalWordDocuments(), 8000, "WORD_LIVE_EXTERNAL_DOCUMENT_CHECK_TIMEOUT");
      if (opened.some(value => {
        try { return keyForWordPath(value) === key; } catch { return false; }
      })) throw new Error("WORD_LIVE_FILE_IN_USE: document is already open in a user Word instance");
    }
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-File", this.workerPath, "-BridgePath", this.bridgePath, "-Path", path];
    if (opts.read_only) args.push("-ReadOnly");
    if (opts.remove_stale_lock) args.push("-RemoveStaleLock");
    if (this.closed) throw new Error("WORD_LIVE_POOL_CLOSED");
    const child = spawn("powershell.exe", args, {
      cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.workerEnv },
    });
    const session: Session = { key, path, worker: child, buffer: "", stderr: "", readOnly: !!opts.read_only, staleLock: false, stopped: false, abandonedMutexRecovered: false, pending: new Map(), tail: Promise.resolve() };
    this.inflight.add(session);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const ready = new Promise<Session>((res, rej) => {
      const timeout = setTimeout(() => fail(new Error("WORD_LIVE_START_TIMEOUT")), 55000);
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; clearTimeout(timeout); rej(error); } };
      child.stderr.on("data", (chunk: string) => { session.stderr = (session.stderr + chunk).slice(-4000); });
      child.stdout.on("data", (chunk: string) => {
        session.buffer += chunk;
        for (;;) {
          const ix = session.buffer.indexOf("\n"); if (ix < 0) break;
          const line = session.buffer.slice(0, ix).trim(); session.buffer = session.buffer.slice(ix + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { session.stderr = (session.stderr + "\n" + line).slice(-4000); continue; }
          if (msg.kind === "failure") { fail(new Error("stage=" + String(msg.stage ?? "unknown") + " line=" + String(msg.position ?? "") + " " + String(msg.error || "WORD_LIVE_START_FAILED"))); continue; }
          if (msg.kind === "owned_process" || msg.kind === "ready") {
            const pid = Number(msg.winwordPid), started = String(msg.winwordStarted ?? "");
            if (!Number.isInteger(pid) || pid <= 0 || !started) {
              fail(new Error("WORD_LIVE_INVALID_PROCESS_ID")); continue;
            }
            if (session.record && (session.record.pid !== pid || session.record.started !== started)) {
              fail(new Error("WORD_LIVE_PROCESS_IDENTITY_CHANGED")); continue;
            }
            if (!session.record) {
              const date = new Date().toISOString();
              session.record = { path, workerPid: child.pid ?? -1, pid, started,
                openedAt: date, lastUsedAt: date, ownerPid: process.pid, ownerId: this.ownerId, readOnly: !!opts.read_only };
              // Durably record ownership BEFORE any Word Documents.Open call.
              this.writeRegistry();
            }
            if (msg.kind === "ready") {
              session.staleLock = !!msg.stale_lock;
              if (!settled) { settled = true; clearTimeout(timeout); res(session); }
            }
            continue;
          }
          if (msg.kind === "response") {
            const pending = session.pending.get(String(msg.id));
            if (!pending) continue;
            session.pending.delete(String(msg.id)); clearTimeout(pending.timer);
            if (msg.ok) pending.resolve(msg.result ?? {}); else pending.reject(new Error(String(msg.error || "WORD_LIVE_OPERATION_FAILED")));
          }
        }
      });
      child.once("error", fail);
      child.once("exit", (code) => {
        const e = new Error("WORD_LIVE_WORKER_EXIT: " + code + " " + session.stderr);
        fail(e);
        for (const p of session.pending.values()) { clearTimeout(p.timer); p.reject(e); }
        session.pending.clear();
        // Includes forced worker death during mutex acquisition / startup.
        void this.destroySession(session).catch(() => {});
      });
    });
    try {
      await ready;
      if (session.stopped) throw new Error("WORD_LIVE_SESSION_CLOSED_DURING_START");
      this.inflight.delete(session);
      this.sessions.set(key, session);
      this.writeRegistry();
      return session;
    }
    catch (error) {
      // Never abandon a child or Word whose PID/start-time arrived before ready.
      await this.destroySession(session);
      throw error;
    }
  }
  private async acquire(opts: WordSessionOptions): Promise<Session> {
    if (this.closed) throw new Error("WORD_LIVE_POOL_CLOSED");
    const path = normalizeWordPath(opts.path), key = path.toLowerCase();
    const existing = this.sessions.get(key);
    if (existing && !existing.stopped) {
      if (existing.readOnly !== !!opts.read_only) throw new Error("WORD_LIVE_SESSION_MODE_MISMATCH: close the session before changing read_only");
      return existing;
    }
    const initializing = this.starting.get(key);
    if (initializing) return initializing;
    const opening = (async () => {
      const deadline = Date.now() + Math.max(10, Number(process.env.NHD_WORD_LIVE_POOL_WAIT_MS ?? 60000));
      while (this.sessions.size + this.starting.size >= this.maxInstances) {
        if (this.closed) throw new Error("WORD_LIVE_POOL_CLOSED");
        if (Date.now() >= deadline) throw new Error("WORD_LIVE_POOL_BUSY: maximum Word Live sessions reached");
        await delay(100);
      }
      if (this.closed) throw new Error("WORD_LIVE_POOL_CLOSED");
      return this.launch(path, key, opts);
    })();
    this.starting.set(key, opening);
    try { return await opening; } finally { this.starting.delete(key); }
  }
  private requestRaw(session: Session, action: string, input: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      if (session.stopped) { rej(new Error("WORD_LIVE_SESSION_CLOSED")); return; }
      const id = randomUUID();
      const timer = setTimeout(() => {
        session.pending.delete(id);
        rej(new Error("WORD_LIVE_OPERATION_TIMEOUT: " + action));
        void this.destroySession(session);
      }, timeoutMs);
      session.pending.set(id, { resolve: res, reject: rej, timer });
      session.worker.stdin.write(JSON.stringify({ id, action, input }) + "\n", "utf8", error => {
        if (!error) return;
        const p = session.pending.get(id); if (!p) return;
        clearTimeout(p.timer); session.pending.delete(id); rej(error);
        void this.destroySession(session);
      });
    });
  }
  async request(action: "word_inspect" | "word_apply" | "test_timeout", opts: WordSessionOptions, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let cancelled = false;
    const requested = (async () => {
      const session = await this.acquire(opts);
      if (cancelled || this.closed) {
        await this.destroySession(session);
        throw new Error("WORD_LIVE_REQUEST_TIMEOUT: cancelled during session startup");
      }
      if (session.readOnly && action !== "word_inspect") throw new Error("WORD_LIVE_READ_ONLY: writes and saves prohibited");
      const act = async () => {
        if (cancelled || session.stopped) throw new Error("WORD_LIVE_REQUEST_TIMEOUT: queued request cancelled");
        const save = action === "word_apply" && (input.operation as {type?: string} | undefined)?.type === "word_save";
        const defaultMs = save ? 45000 : 20000;
        const maxMs = save ? 45000 : 25000;
        const data = await this.requestRaw(session, action, input, Math.max(100, Math.min(maxMs, opts.timeout_ms ?? defaultMs)));
        if (session.record) { session.record.lastUsedAt = new Date().toISOString(); this.writeRegistry(); }
        return { ...data, path: session.path, pid: session.record?.pid, stale_lock: session.staleLock, abandoned_mutex_recovered:session.abandonedMutexRecovered };
      };
      const run = session.tail.then(act);
      session.tail = run.catch(() => {});
      return run;
    })();
    try {
      return await bounded(requested, 85000, "WORD_LIVE_REQUEST_TIMEOUT");
    } catch (error) {
      if (error instanceof Error && error.message === "WORD_LIVE_REQUEST_TIMEOUT") {
        cancelled = true;
        const key = keyForWordPath(opts.path);
        const targets = [...new Set([...this.inflight, ...this.sessions.values()])].filter(s => s.key === key);
        await Promise.allSettled(targets.map(s => this.destroySession(s)));
      }
      throw error;
    }
  }
  private async destroySession(session: Session): Promise<void> {
    if (session.stopped) return;
    session.stopped = true;
    this.sessions.delete(session.key);
    this.inflight.delete(session);
    for (const p of session.pending.values()) {
      clearTimeout(p.timer); p.reject(new Error("WORD_LIVE_SESSION_CLOSED"));
    }
    session.pending.clear();
    try { session.worker.stdin.end(); } catch {}
    try { session.worker.kill(); } catch {}
    session.worker.stdout.destroy();
    session.worker.stderr.destroy();
    if (session.record) {
      await delay(250);
      await stopVerifiedWordProcess(session.record);
      // Only erase the evidence once the exact recorded process is gone.
      this.removeRegistryEntry(session.record);
    }
  }
  async close(pathInput: string): Promise<Record<string, unknown>> {
    const key = keyForWordPath(pathInput);
    const session = this.sessions.get(key);
    if (!session) return { closed: false, path: normalizeWordPath(pathInput) };
    try {
      await bounded(session.tail.catch(() => {}), 15000, "WORD_LIVE_CLOSE_QUEUE_TIMEOUT");
      await bounded(this.requestRaw(session, "close", {}, 4000), 5000, "WORD_LIVE_CLOSE_TIMEOUT");
      await delay(250);
    } finally { await this.destroySession(session); }
    return { closed: true, path: session.path, pid: session.record?.pid };
  }
  private async reapIdle() {
    if (Date.now() - this.lastOrphanSweep >= 300000) {
      this.lastOrphanSweep = Date.now();
      await this.cleanupOrphans().catch(() => {});
    }
    for (const entry of [...this.sessions.values()]) {
      if (entry.record && Date.now() - Date.parse(entry.record.lastUsedAt) > this.idleMs) {
        await this.close(entry.path).catch(() => {});
      }
    }
  }
  async closeAll() {
    this.closed = true;
    clearInterval(this.timer);
    const starting = [...this.inflight];
    await bounded(Promise.allSettled([
      ...[...this.sessions.values()].map(s => this.close(s.path)),
      ...starting.map(s => this.destroySession(s)),
    ]), 30000, "WORD_LIVE_CLOSE_ALL_TIMEOUT");
  }
}
