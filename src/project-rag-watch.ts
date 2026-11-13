/**
 * Auto-sync of project RAG stores (0.24.33).
 * The owner opts a project in ONCE with an authorized task; afterwards file changes inside that
 * project are re-ingested (or removed) in the background. Every mutation is audited, the same
 * type/location/size gates as manual ingest apply, and Emergency Stop / write-disabled pauses work.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type RagLike = {
  resolveProject(root: string): string;
  scan(root: string, exclude?: string[], maxFiles?: number): string[];
  eligible(root: string, path: string): boolean;
  excluded(root: string, full: string, skip: Set<string>): boolean;
  indexedSources(root: string): Promise<Array<{ source: string; size_bytes: number; modified_ms: number }>>;
  index(root: string, path: string): Promise<any>;
  remove(root: string, path: string): Promise<any>;
};
type WatchedProject = { root: string; exclude: string[]; enabledAt: string; taskRunId: string | null };
type Job = { kind: "ingest" | "remove" | "sync"; root: string; path?: string };
type ProjectRuntime = {
  watcher: FSWatcher | null; mode: "recursive" | "root-only" | "off"; lastSyncAt: string | null; lastEventAt: string | null;
  ingested: number; unchanged: number; removed: number; failed: number;
  errors: Array<{ path: string; error: string; at: string }>; failedSig: Map<string, string>;
};
export type RagWatchOptions = {
  statePath: string;
  store: { audit(action: string, status: string, detail: unknown): void };
  gate: () => { emergencyStop?: boolean; writeEnabled?: boolean };
  debounceMs?: number; rescanMs?: number; maxQueue?: number;
  watchFn?: typeof watch;
};
const nowIso = () => new Date().toISOString();
const inside = (root: string, full: string) => {
  const rel = relative(root, full);
  return rel !== "" && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel);
};

export class ProjectRagWatcher {
  private readonly projects = new Map<string, WatchedProject>();
  private readonly runtime = new Map<string, ProjectRuntime>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queue: Job[] = [];
  private readonly queued = new Set<string>();
  private running = false;
  private pausedTimer: ReturnType<typeof setTimeout> | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly debounceMs: number;
  private readonly rescanMs: number;
  private readonly maxQueue: number;
  private readonly watchFn: typeof watch;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly rag: RagLike, private readonly options: RagWatchOptions) {
    this.debounceMs = options.debounceMs ?? 4000;
    this.rescanMs = options.rescanMs ?? 10 * 60_000;
    this.maxQueue = options.maxQueue ?? 5000;
    this.watchFn = options.watchFn ?? watch;
  }

  /** Restore persisted projects (called once at startup). Invalid entries are skipped, not deleted. */
  restore() {
    for (const project of this.readState()) {
      try { this.start(project, false); } catch (error) { this.options.store.audit("project_rag_watch_restore", "failure", { root: project.root, error: String((error as Error)?.message ?? error) }); }
    }
    this.ensureRescan();
    return this.status();
  }

  enable(rootInput: string, exclude: string[] = [], taskRunId: string | null = null) {
    const root = this.rag.resolveProject(rootInput);
    const clean = [...new Set(exclude.map(x => String(x).trim().replace(/^[\\/]+|[\\/]+$/g, "").replace(/\//g, "\\")).filter(Boolean))].slice(0, 50);
    if (clean.some(x => x.split("\\").includes(".."))) throw new Error("Exclude entries must be relative folders inside the project.");
    const project: WatchedProject = { root, exclude: clean, enabledAt: nowIso(), taskRunId };
    this.stopOne(root);
    this.start(project, true);
    this.writeState();
    this.ensureRescan();
    this.options.store.audit("project_rag_watch_enable", "success", { root, exclude: clean, taskRunId });
    return this.status(root);
  }

  disable(rootInput: string) {
    const root = this.rag.resolveProject(rootInput);
    const existed = this.projects.has(root);
    this.stopOne(root);
    this.projects.delete(root);
    this.runtime.delete(root);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].root === root) { this.queued.delete(this.key(this.queue[i])); this.queue.splice(i, 1); }
    this.writeState();
    if (existed) this.options.store.audit("project_rag_watch_disable", "success", { root });
    return { ok: true, root, wasWatched: existed };
  }

  /** Queue a full reconcile of one watched project (or all). */
  sync(rootInput?: string) {
    const roots = rootInput ? [this.rag.resolveProject(rootInput)] : [...this.projects.keys()];
    for (const root of roots) {
      if (!this.projects.has(root)) throw new Error("Project is not auto-synced; enable it first.");
      this.push({ kind: "sync", root });
    }
    return this.status(rootInput ? roots[0] : undefined);
  }

  status(rootFilter?: string) {
    const list = [...this.projects.values()].filter(p => !rootFilter || p.root === rootFilter).map(p => {
      const rt = this.runtime.get(p.root);
      return { root: p.root, exclude: p.exclude, enabledAt: p.enabledAt, watching: rt?.mode ?? "off",
        lastSyncAt: rt?.lastSyncAt ?? null, lastEventAt: rt?.lastEventAt ?? null,
        pending: this.queue.filter(j => j.root === p.root).length,
        counters: { ingested: rt?.ingested ?? 0, unchanged: rt?.unchanged ?? 0, removed: rt?.removed ?? 0, failed: rt?.failed ?? 0 },
        recentErrors: (rt?.errors ?? []).slice(-10) };
    });
    const gate = this.options.gate();
    return { ok: true, paused: Boolean(gate.emergencyStop || !gate.writeEnabled), busy: this.running, queue: this.queue.length, projects: list };
  }

  /** Resolves when the queue is drained (tests / diagnostics). */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0 && this.timers.size === 0) return Promise.resolve();
    return new Promise(done => this.idleWaiters.push(done));
  }

  stopAll() {
    for (const root of [...this.projects.keys()]) this.stopOne(root);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (this.pausedTimer) clearTimeout(this.pausedTimer);
    this.rescanTimer = null; this.pausedTimer = null;
  }

  // ---- internals ----
  private start(project: WatchedProject, initialSync: boolean) {
    const root = this.rag.resolveProject(project.root);
    if (!existsSync(root)) throw new Error("Project directory does not exist.");
    project = { ...project, root };
    this.projects.set(root, project);
    const rt: ProjectRuntime = this.runtime.get(root) ?? { watcher: null, mode: "off", lastSyncAt: null, lastEventAt: null, ingested: 0, unchanged: 0, removed: 0, failed: 0, errors: [], failedSig: new Map() };
    this.runtime.set(root, rt);
    const onEvent = (_type: string, filename: string | Buffer | null) => {
      rt.lastEventAt = nowIso();
      if (!filename) { this.debounce(root + "|*sync", () => this.push({ kind: "sync", root })); return; }
      const full = resolve(root, String(filename));
      if (!inside(root, full)) return;
      this.debounce(full, () => this.onPathChanged(root, full));
    };
    try { rt.watcher = this.watchFn(root, { recursive: true }, onEvent); rt.mode = "recursive"; }
    catch { rt.watcher = this.watchFn(root, { recursive: false }, onEvent); rt.mode = "root-only"; }
    rt.watcher.on?.("error", (error: Error) => this.recordError(root, root, error));
    // Always reconcile on start: edits made while the harness was offline must be picked up.
    void initialSync;
    this.push({ kind: "sync", root });
  }

  private stopOne(root: string) {
    const rt = this.runtime.get(root);
    try { rt?.watcher?.close(); } catch { /* already closed */ }
    if (rt) { rt.watcher = null; rt.mode = "off"; }
    for (const [key, timer] of [...this.timers.entries()]) {
      if (key === root + "|*sync" || inside(root, key)) { clearTimeout(timer); this.timers.delete(key); }
    }
  }

  private debounce(key: string, fn: () => void) {
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => { this.timers.delete(key); fn(); this.maybeIdle(); }, this.debounceMs);
    (timer as any).unref?.();
    this.timers.set(key, timer);
  }

  private onPathChanged(root: string, full: string) {
    const project = this.projects.get(root);
    if (!project) return;
    let isDir = false;
    try { isDir = existsSync(full) && statSync(full).isDirectory(); } catch { /* raced */ }
    if (isDir) { this.push({ kind: "sync", root }); return; }
    const skip = new Set(project.exclude.map(x => x.toLowerCase()));
    if (this.rag.excluded(root, full, skip)) return;
    if (!existsSync(full)) { this.push({ kind: "remove", root, path: full }); return; }
    if (this.rag.eligible(root, full)) this.push({ kind: "ingest", root, path: full });
  }

  private key(job: Job) { return job.kind + "|" + job.root + "|" + (job.path ?? ""); }

  private push(job: Job) {
    const key = this.key(job);
    if (this.queued.has(key)) { void this.drain(); return; }
    if (this.queue.length >= this.maxQueue) { this.recordError(job.root, job.path ?? job.root, new Error("Auto-sync queue full; change skipped (next periodic rescan will retry).")); return; }
    this.queued.add(key);
    this.queue.push(job);
    void this.drain();
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const gate = this.options.gate();
        if (gate.emergencyStop || !gate.writeEnabled) {
          if (!this.pausedTimer) { this.pausedTimer = setTimeout(() => { this.pausedTimer = null; void this.drain(); }, 30_000); (this.pausedTimer as any).unref?.(); }
          break;
        }
        const job = this.queue.shift()!;
        this.queued.delete(this.key(job));
        if (!this.projects.has(job.root)) continue;
        try { await this.run(job); } catch (error) { this.recordError(job.root, job.path ?? job.root, error); }
      }
    } finally {
      this.running = false;
      this.maybeIdle();
    }
  }

  private maybeIdle() {
    if (this.running || this.queue.length || this.timers.size) return;
    const waiters = this.idleWaiters; this.idleWaiters = [];
    for (const done of waiters) done();
  }

  private signature(path: string) { try { const s = statSync(path); return s.size + ":" + Math.round(s.mtimeMs); } catch { return "missing"; } }

  private async run(job: Job) {
    const rt = this.runtime.get(job.root)!;
    if (job.kind === "sync") {
      const project = this.projects.get(job.root)!;
      const manifest = await this.rag.indexedSources(job.root);
      const known = new Map(manifest.map(m => [resolve(m.source).toLowerCase(), m]));
      const present = new Set<string>();
      for (const file of this.rag.scan(job.root, project.exclude)) {
        present.add(resolve(file).toLowerCase());
        const m = known.get(resolve(file).toLowerCase());
        let stat; try { stat = statSync(file); } catch { continue; }
        if (m && m.size_bytes === stat.size && Math.abs(m.modified_ms - stat.mtimeMs) <= 3) continue;
        if (rt.failedSig.get(file) === this.signature(file)) continue; // failed before and unchanged since
        this.push({ kind: "ingest", root: job.root, path: file });
      }
      for (const m of manifest) if (!present.has(resolve(m.source).toLowerCase())) this.push({ kind: "remove", root: job.root, path: m.source });
      rt.lastSyncAt = nowIso();
      return;
    }
    if (job.kind === "remove") {
      const result = await this.rag.remove(job.root, job.path!);
      const removed = Number(result?.removed_chunks ?? 0);
      if (removed > 0) { rt.removed++; this.options.store.audit("project_rag_auto_remove", "success", { projectRoot: job.root, source: job.path, chunks: removed }); }
      return;
    }
    const sig = this.signature(job.path!);
    if (rt.failedSig.get(job.path!) === sig) return;
    try {
      const result = await this.rag.index(job.root, job.path!);
      rt.failedSig.delete(job.path!);
      if (result?.unchanged) { rt.unchanged++; return; }
      rt.ingested++;
      this.options.store.audit("project_rag_auto_ingest", "success", { projectRoot: job.root, source: job.path, chunks: result?.chunks, actor: "rag-watch" });
    } catch (error) {
      rt.failedSig.set(job.path!, sig);
      rt.failed++;
      this.options.store.audit("project_rag_auto_ingest", "failure", { projectRoot: job.root, source: job.path, error: String((error as Error)?.message ?? error).slice(0, 300), actor: "rag-watch" });
      this.recordError(job.root, job.path!, error);
    }
  }

  private recordError(root: string, path: string, error: unknown) {
    const rt = this.runtime.get(root);
    if (!rt) return;
    rt.errors.push({ path, error: String((error as Error)?.message ?? error).slice(0, 300), at: nowIso() });
    if (rt.errors.length > 50) rt.errors.splice(0, rt.errors.length - 50);
  }

  private ensureRescan() {
    if (this.rescanTimer || this.rescanMs <= 0) return;
    this.rescanTimer = setInterval(() => { for (const root of this.projects.keys()) this.push({ kind: "sync", root }); }, this.rescanMs);
    (this.rescanTimer as any).unref?.();
  }

  private readState(): WatchedProject[] {
    try {
      if (!existsSync(this.options.statePath)) return [];
      const data = JSON.parse(readFileSync(this.options.statePath, "utf8").replace(/^﻿/, ""));
      return Array.isArray(data?.projects) ? data.projects.filter((p: any) => p && typeof p.root === "string").map((p: any) => ({
        root: p.root, exclude: Array.isArray(p.exclude) ? p.exclude.map(String) : [], enabledAt: String(p.enabledAt ?? ""), taskRunId: p.taskRunId ?? null })) : [];
    } catch { return []; }
  }

  private writeState() {
    const path = this.options.statePath;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, projects: [...this.projects.values()] }, null, 2), { encoding: "utf8" });
    renameSync(tmp, path);
  }
}
export const ragWatchStatePath = (dataDir: string) => join(dataDir, "project-rag-watch.json");
