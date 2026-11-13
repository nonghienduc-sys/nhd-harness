import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Store } from "./db.js";
import type { TaskRunManager } from "./task-runtime.js";

export type PlanKind = "upgrade" | "project" | "workflow" | "general";
export type PlanState = "planned" | "running" | "paused" | "blocked" | "completed" | "failed" | "cancelled";
export type PlanPhaseState = "pending" | "running" | "blocked" | "verified" | "failed" | "skipped";

export type PlanPhaseInput = {
  key?: string;
  title: string;
  objective?: string;
  required?: boolean;
};

export type PlanPhaseView = {
  id: string;
  key: string;
  sequence: number;
  title: string;
  objective: string;
  state: PlanPhaseState;
  required: boolean;
  summary: string | null;
  note: string | null;
  receiptId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};

export type PlanView = {
  id: string;
  kind: PlanKind;
  title: string;
  objective: string;
  root: string | null;
  taskRunId: string | null;
  state: PlanState;
  percent: number;
  phaseCount: number;
  requiredPhaseCount: number;
  verifiedPhaseCount: number;
  currentPhase: PlanPhaseView | null;
  nextPhase: PlanPhaseView | null;
  phases: PlanPhaseView[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

const PLAN_TERMINAL = new Set<PlanState>(["completed", "failed", "cancelled"]);
const PHASE_TERMINAL = new Set<PlanPhaseState>(["verified", "failed", "skipped"]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/i,
  /\b(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|companion[_-]?secret)\s*[:=]\s*[^\s,;]{4,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function text(value: unknown, max: number, name: string, allowEmpty = false) {
  const out = String(value ?? "").trim();
  if ((!allowEmpty && !out) || out.length > max) throw new Error(`${name} is empty or exceeds ${max} characters.`);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(out))) throw new Error(`${name} appears to contain secret material and cannot be stored in plan state.`);
  return out;
}

function id(prefix: string) { return `${prefix}-${randomBytes(12).toString("hex")}`; }
function keyFor(index: number, candidate?: string) {
  const value = String(candidate ?? `phase-${index + 1}`).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)) throw new Error(`Invalid phase key '${value}'.`);
  return value;
}

export class PlanStateService {
  constructor(readonly store: Store, readonly taskRuns?: TaskRunManager, readonly now: () => number = Date.now) {
    this.initSchema();
  }

  create(input: { kind?: PlanKind; title: string; objective?: string; root?: string; taskRunId?: string; phases: PlanPhaseInput[] }): PlanView {
    const kind = input.kind ?? "general";
    const title = text(input.title, 500, "plan title");
    const objective = text(input.objective ?? title, 4_000, "plan objective");
    if (!Array.isArray(input.phases) || input.phases.length < 1 || input.phases.length > 64) throw new Error("Plan requires 1-64 ordered phases.");
    const task = input.taskRunId && this.taskRuns ? this.taskRuns.get(input.taskRunId) : null;
    const taskRunId = input.taskRunId ? text(input.taskRunId, 256, "task run id") : null;
    let root = input.root ? this.root(input.root) : task?.root ?? null;
    if (task?.root && root && task.root.toLowerCase() !== root.toLowerCase()) throw new Error("Plan root must match the bound task project root.");
    if (!root && task?.root) root = task.root;
    const normalized = input.phases.map((phase, index) => ({
      key: keyFor(index, phase.key),
      title: text(phase.title, 500, `phase ${index + 1} title`),
      objective: text(phase.objective ?? phase.title, 4_000, `phase ${index + 1} objective`),
      required: phase.required !== false,
    }));
    if (new Set(normalized.map((phase) => phase.key)).size !== normalized.length) throw new Error("Phase keys must be unique within a plan.");
    if (!normalized.some((phase) => phase.required)) throw new Error("Plan must have at least one required phase.");
    const planId = id("plan");
    const at = new Date(this.now()).toISOString();
    this.transaction(() => {
      this.store.db.prepare(`INSERT INTO agent_plans(id,kind,title,objective,root,task_run_id,state,current_phase_key,created_at,updated_at,completed_at)
        VALUES(?,?,?,?,?,?,?,NULL,?,?,NULL)`).run(planId, kind, title, objective, root, taskRunId, "planned", at, at);
      const insert = this.store.db.prepare(`INSERT INTO agent_plan_phases(id,plan_id,phase_key,sequence,title,objective,state,required,summary,note,receipt_id,started_at,completed_at,updated_at)
        VALUES(?,?,?,?,?,?,?, ?,NULL,NULL,NULL,NULL,NULL,?)`);
      normalized.forEach((phase, index) => insert.run(id("phase"), planId, phase.key, index + 1, phase.title, phase.objective, "pending", phase.required ? 1 : 0, at));
    });
    this.audit("created", { planId, kind, title, root, taskRunId, phaseCount: normalized.length });
    return this.get(planId);
  }

  get(planIdInput: string): PlanView {
    const planId = text(planIdInput, 256, "plan id");
    const row = this.store.db.prepare("SELECT * FROM agent_plans WHERE id=?").get(planId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Plan was not found.");
    return this.view(row);
  }

  list(input: { root?: string; taskRunId?: string; state?: PlanState; limit?: number } = {}): PlanView[] {
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 200));
    const where: string[] = [];
    const args: (string | number | null)[] = [];
    if (input.root) { where.push("LOWER(root)=LOWER(?)"); args.push(this.root(input.root)); }
    if (input.taskRunId) { where.push("task_run_id=?"); args.push(text(input.taskRunId, 256, "task run id")); }
    if (input.state) { where.push("state=?"); args.push(input.state); }
    const sql = `SELECT * FROM agent_plans${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`;
    args.push(limit);
    return (this.store.db.prepare(sql).all(...args) as Record<string, unknown>[]).map((row) => this.view(row));
  }

  stats() {
    const rows = this.store.db.prepare("SELECT state,COUNT(*) AS count FROM agent_plans GROUP BY state").all() as Array<{ state: string; count: number }>;
    const byState: Record<string, number> = {};
    let total = 0;
    for (const row of rows) { byState[row.state] = Number(row.count); total += Number(row.count); }
    return { total, byState, active: (byState.running ?? 0) + (byState.blocked ?? 0), paused: byState.paused ?? 0, planned: byState.planned ?? 0 };
  }

  start(planId: string): PlanView {
    const plan = this.get(planId);
    if (plan.state !== "planned" && plan.state !== "paused") throw new Error(`Plan is ${plan.state}; it cannot be started.`);
    const phase = plan.currentPhase && !PHASE_TERMINAL.has(plan.currentPhase.state)
      ? plan.currentPhase
      : plan.phases.find((item) => item.state === "pending") ?? null;
    if (!phase) return this.finishIfComplete(plan.id);
    const at = new Date(this.now()).toISOString();
    this.transaction(() => {
      if (phase.state === "pending") this.store.db.prepare("UPDATE agent_plan_phases SET state='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?").run(at, at, phase.id);
      this.store.db.prepare("UPDATE agent_plans SET state='running',current_phase_key=?,updated_at=? WHERE id=?").run(phase.key, at, plan.id);
    });
    this.audit("started", { planId: plan.id, phase: phase.key });
    return this.get(plan.id);
  }

  pause(planId: string, note?: string): PlanView {
    const plan = this.get(planId);
    if (plan.state !== "running" && plan.state !== "blocked") throw new Error(`Plan is ${plan.state}; it cannot be paused.`);
    const at = new Date(this.now()).toISOString();
    this.store.db.prepare("UPDATE agent_plans SET state='paused',updated_at=? WHERE id=?").run(at, plan.id);
    if (note && plan.currentPhase) this.store.db.prepare("UPDATE agent_plan_phases SET note=?,updated_at=? WHERE id=?").run(text(note, 2_000, "pause note"), at, plan.currentPhase.id);
    this.audit("paused", { planId: plan.id, phase: plan.currentPhase?.key ?? null });
    return this.get(plan.id);
  }

  resume(planId: string): PlanView {
    const plan = this.get(planId);
    if (plan.state !== "paused" && plan.state !== "blocked") throw new Error(`Plan is ${plan.state}; it cannot be resumed.`);
    const phase = plan.currentPhase ?? plan.phases.find((item) => item.state === "pending" || item.state === "blocked") ?? null;
    if (!phase) return this.finishIfComplete(plan.id);
    const at = new Date(this.now()).toISOString();
    this.transaction(() => {
      if (phase.state === "blocked" || phase.state === "pending") this.store.db.prepare("UPDATE agent_plan_phases SET state='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?").run(at, at, phase.id);
      this.store.db.prepare("UPDATE agent_plans SET state='running',current_phase_key=?,updated_at=? WHERE id=?").run(phase.key, at, plan.id);
    });
    this.audit("resumed", { planId: plan.id, phase: phase.key });
    return this.get(plan.id);
  }

  verifyPhase(planId: string, phaseKeyInput: string, input: { summary?: string; receiptId?: string } = {}): PlanView {
    const plan = this.get(planId);
    if (plan.state !== "running") throw new Error(`Plan is ${plan.state}; phase verification requires a running plan.`);
    const phase = this.phase(plan, phaseKeyInput);
    if (!plan.currentPhase || phase.key !== plan.currentPhase.key) throw new Error(`Phase '${phase.key}' is not the current phase.`);
    if (phase.state !== "running") throw new Error(`Phase '${phase.key}' is ${phase.state}; only a running phase can be verified.`);
    const summary = input.summary ? text(input.summary, 8_000, "phase verification summary") : "Verified phase completed.";
    const receiptId = input.receiptId ? text(input.receiptId, 500, "phase receipt id") : null;
    const at = new Date(this.now()).toISOString();
    this.transaction(() => {
      this.store.db.prepare("UPDATE agent_plan_phases SET state='verified',summary=?,receipt_id=?,completed_at=?,updated_at=? WHERE id=?").run(summary, receiptId, at, at, phase.id);
      this.store.db.prepare("UPDATE agent_plans SET current_phase_key=NULL,updated_at=? WHERE id=?").run(at, plan.id);
    });
    const advanced = this.advance(plan.id);
    this.audit("phase_verified", { planId: plan.id, phase: phase.key, next: advanced.currentPhase?.key ?? null, completed: advanced.state === "completed" });
    return advanced;
  }

  blockPhase(planId: string, phaseKeyInput: string, note: string): PlanView {
    const plan = this.get(planId);
    if (plan.state !== "running") throw new Error(`Plan is ${plan.state}; only a running plan can be blocked.`);
    const phase = this.phase(plan, phaseKeyInput);
    if (!plan.currentPhase || phase.key !== plan.currentPhase.key || phase.state !== "running") throw new Error("Only the current running phase can be blocked.");
    const at = new Date(this.now()).toISOString();
    const safeNote = text(note, 4_000, "block note");
    this.transaction(() => {
      this.store.db.prepare("UPDATE agent_plan_phases SET state='blocked',note=?,updated_at=? WHERE id=?").run(safeNote, at, phase.id);
      this.store.db.prepare("UPDATE agent_plans SET state='blocked',updated_at=? WHERE id=?").run(at, plan.id);
    });
    this.audit("phase_blocked", { planId: plan.id, phase: phase.key, note: safeNote.slice(0, 500) });
    return this.get(plan.id);
  }

  failPhase(planId: string, phaseKeyInput: string, note: string): PlanView {
    const plan = this.get(planId);
    if (PLAN_TERMINAL.has(plan.state)) throw new Error(`Plan is ${plan.state}.`);
    const phase = this.phase(plan, phaseKeyInput);
    if (!plan.currentPhase || phase.key !== plan.currentPhase.key || !["running", "blocked"].includes(phase.state)) throw new Error("Only the current running/blocked phase can fail.");
    const at = new Date(this.now()).toISOString();
    const safeNote = text(note, 4_000, "failure note");
    this.transaction(() => {
      this.store.db.prepare("UPDATE agent_plan_phases SET state='failed',note=?,completed_at=?,updated_at=? WHERE id=?").run(safeNote, at, at, phase.id);
      this.store.db.prepare("UPDATE agent_plans SET state='failed',updated_at=? WHERE id=?").run(at, plan.id);
    });
    this.audit("phase_failed", { planId: plan.id, phase: phase.key, note: safeNote.slice(0, 500) });
    return this.get(plan.id);
  }

  retryPhase(planId: string, phaseKeyInput: string, note?: string): PlanView {
    const plan = this.get(planId);
    const phase = this.phase(plan, phaseKeyInput);
    if (!["failed", "blocked"].includes(phase.state)) throw new Error(`Phase '${phase.key}' is ${phase.state}; only failed/blocked phases can be retried.`);
    const previousRequired = plan.phases.filter((item) => item.sequence < phase.sequence && item.required);
    if (previousRequired.some((item) => item.state !== "verified")) throw new Error("A previous required phase is not verified; retry cannot jump ahead.");
    const at = new Date(this.now()).toISOString();
    this.transaction(() => {
      this.store.db.prepare("UPDATE agent_plan_phases SET state='running',note=?,completed_at=NULL,updated_at=?,started_at=COALESCE(started_at,?) WHERE id=?").run(note ? text(note, 2_000, "retry note") : phase.note, at, at, phase.id);
      this.store.db.prepare("UPDATE agent_plans SET state='running',current_phase_key=?,completed_at=NULL,updated_at=? WHERE id=?").run(phase.key, at, plan.id);
    });
    this.audit("phase_retried", { planId: plan.id, phase: phase.key });
    return this.get(plan.id);
  }

  cancel(planId: string, note?: string): PlanView {
    const plan = this.get(planId);
    if (PLAN_TERMINAL.has(plan.state)) throw new Error(`Plan is already ${plan.state}.`);
    const at = new Date(this.now()).toISOString();
    this.transaction(() => {
      if (plan.currentPhase && note) this.store.db.prepare("UPDATE agent_plan_phases SET note=?,updated_at=? WHERE id=?").run(text(note, 2_000, "cancel note"), at, plan.currentPhase.id);
      this.store.db.prepare("UPDATE agent_plans SET state='cancelled',current_phase_key=NULL,updated_at=?,completed_at=? WHERE id=?").run(at, at, plan.id);
    });
    this.audit("cancelled", { planId: plan.id, phase: plan.currentPhase?.key ?? null });
    return this.get(plan.id);
  }

  taskCompletionGuard(taskRunId: string): { allowed: boolean; reason?: string } {
    const linked = this.list({ taskRunId, limit: 100 });
    if (!linked.length) return { allowed: true };
    const incomplete = linked.filter((plan) => plan.state !== "completed");
    if (!incomplete.length) return { allowed: true };
    const plan = incomplete[0];
    const phase = plan.currentPhase ?? plan.nextPhase;
    return { allowed: false, reason: `Task is bound to plan '${plan.title}' (${plan.percent}%). Parent task cannot complete until all required plan phases are verified.${phase ? ` Current/next phase: ${phase.sequence}. ${phase.title}.` : ""}` };
  }

  private advance(planId: string): PlanView {
    const plan = this.get(planId);
    const failedRequired = plan.phases.find((phase) => phase.required && phase.state === "failed");
    if (failedRequired) return this.get(planId);
    const next = plan.phases.find((phase) => phase.state === "pending") ?? null;
    const requiredRemaining = plan.phases.some((phase) => phase.required && phase.state !== "verified");
    if (!requiredRemaining) {
      const at = new Date(this.now()).toISOString();
      this.transaction(() => {
        this.store.db.prepare("UPDATE agent_plan_phases SET state='skipped',completed_at=?,updated_at=? WHERE plan_id=? AND required=0 AND state='pending'").run(at, at, plan.id);
        this.store.db.prepare("UPDATE agent_plans SET state='completed',current_phase_key=NULL,completed_at=?,updated_at=? WHERE id=?").run(at, at, plan.id);
      });
      return this.get(plan.id);
    }
    if (!next) throw new Error("Plan has remaining required phases but no pending phase to advance to.");
    const at = new Date(this.now()).toISOString();
    this.transaction(() => {
      this.store.db.prepare("UPDATE agent_plan_phases SET state='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=?").run(at, at, next.id);
      this.store.db.prepare("UPDATE agent_plans SET state='running',current_phase_key=?,updated_at=? WHERE id=?").run(next.key, at, plan.id);
    });
    return this.get(plan.id);
  }

  private finishIfComplete(planId: string) {
    const plan = this.get(planId);
    if (plan.phases.every((phase) => !phase.required || phase.state === "verified")) return this.advance(planId);
    throw new Error("Plan cannot start/finish because no runnable phase was found while required work remains.");
  }

  private phase(plan: PlanView, keyInput: string) {
    const key = text(keyInput, 80, "phase key");
    const phase = plan.phases.find((item) => item.key === key);
    if (!phase) throw new Error(`Phase '${key}' was not found in plan '${plan.title}'.`);
    return phase;
  }

  private view(row: Record<string, unknown>): PlanView {
    const planId = String(row.id);
    const phases = (this.store.db.prepare("SELECT * FROM agent_plan_phases WHERE plan_id=? ORDER BY sequence ASC").all(planId) as Record<string, unknown>[]).map((phase) => this.phaseView(phase));
    const required = phases.filter((phase) => phase.required);
    const verified = required.filter((phase) => phase.state === "verified").length;
    const currentKey = row.current_phase_key == null ? null : String(row.current_phase_key);
    const currentPhase = currentKey ? phases.find((phase) => phase.key === currentKey) ?? null : null;
    const nextPhase = phases.find((phase) => phase.state === "pending" && (!currentPhase || phase.sequence > currentPhase.sequence)) ?? null;
    return {
      id: planId,
      kind: String(row.kind) as PlanKind,
      title: String(row.title),
      objective: String(row.objective),
      root: row.root == null ? null : String(row.root),
      taskRunId: row.task_run_id == null ? null : String(row.task_run_id),
      state: String(row.state) as PlanState,
      percent: required.length ? Math.round((verified / required.length) * 100) : 100,
      phaseCount: phases.length,
      requiredPhaseCount: required.length,
      verifiedPhaseCount: verified,
      currentPhase,
      nextPhase,
      phases,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    };
  }

  private phaseView(row: Record<string, unknown>): PlanPhaseView {
    return {
      id: String(row.id), key: String(row.phase_key), sequence: Number(row.sequence), title: String(row.title), objective: String(row.objective),
      state: String(row.state) as PlanPhaseState, required: Number(row.required) === 1,
      summary: row.summary == null ? null : String(row.summary), note: row.note == null ? null : String(row.note), receiptId: row.receipt_id == null ? null : String(row.receipt_id),
      startedAt: row.started_at == null ? null : String(row.started_at), completedAt: row.completed_at == null ? null : String(row.completed_at), updatedAt: String(row.updated_at),
    };
  }

  private root(value: string) {
    const raw = text(value, 5_000, "plan root");
    if (!isAbsolute(raw)) throw new Error("Plan root must be an absolute path.");
    return resolve(raw);
  }

  private initSchema() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_plans(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL,
        root TEXT, task_run_id TEXT, state TEXT NOT NULL, current_phase_key TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_plans_root ON agent_plans(root,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_plans_task ON agent_plans(task_run_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_plans_state ON agent_plans(state,updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_plan_phases(
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, phase_key TEXT NOT NULL, sequence INTEGER NOT NULL,
        title TEXT NOT NULL, objective TEXT NOT NULL, state TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1,
        summary TEXT, note TEXT, receipt_id TEXT, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL,
        UNIQUE(plan_id,phase_key), UNIQUE(plan_id,sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_plan_phases_plan ON agent_plan_phases(plan_id,sequence);
    `);
  }

  private transaction<T>(fn: () => T): T {
    this.store.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.store.db.exec("COMMIT"); return value; }
    catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }

  private audit(action: string, detail: Record<string, unknown>) {
    try { this.store.audit("plan_state", action, detail); } catch {}
  }
}

