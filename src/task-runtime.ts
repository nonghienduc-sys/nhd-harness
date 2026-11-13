import { randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { Store } from "./db.js";
import { TaskAuthorizationRisk, TaskAuthorizationService, TaskAuthorizationView } from "./task-authorization.js";

export type TaskRunState = "planned" | "running" | "waiting_confirmation" | "paused" | "completed" | "failed" | "cancelled" | "expired";
export type TaskStepState = "waiting_confirmation" | "running" | "verified" | "failed" | "interrupted";
export type TaskReferenceKind = "file" | "document" | "project" | "url" | "message" | "receipt" | "other";

export type TaskReference = {
  id: string;
  kind: TaskReferenceKind;
  label: string;
  location: string;
  fingerprint: string | null;
  createdAt: string;
};

export type TaskCheckpoint = {
  sequence: number;
  summary: string;
  nextAction: string;
  createdAt: string;
};

export type TaskStep = {
  id: string;
  sequence: number;
  route: string;
  description: string;
  state: TaskStepState;
  requiresConfirmation: boolean;
  receiptId: string | null;
  note: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type TaskRunView = {
  id: string;
  objective: string;
  root: string | null;
  state: TaskRunState;
  maxSteps: number;
  maxRuntimeMs: number;
  stepCount: number;
  activeStepId: string | null;
  checkpointSequence: number;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  checkpoints: TaskCheckpoint[];
  references: TaskReference[];
  steps: TaskStep[];
  authorization: TaskAuthorizationView | null;
};

export type McpTaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed";

export type McpTaskProjection = {
  resultType: "complete";
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  inputRequests?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  adapterOnly: true;
};

export type AgentCycleDirective = {
  taskId: string;
  phase: "ready_for_next_step" | "await_action_verification" | "input_required" | "terminal";
  recommendedOperation: "begin_step" | "verify_current_step" | "confirm_or_resume" | "none";
  message: string;
  nextAction: string;
  activeStep: TaskStep | null;
  protocolTask: McpTaskProjection;
  safety: { executeActions: false; replayAmbiguousActions: false; taskMetadataIsAuthorization: false };
};

export type TaskRunManagerOptions = {
  roots?: string[];
  maxReferences?: number;
  maxCheckpointHistory?: number;
  maxStepHistory?: number;
  now?: () => number;
};

export class TaskRunError extends Error {
  constructor(readonly code: "NOT_FOUND" | "INVALID_STATE" | "INVALID_ROOT" | "STEP_LIMIT" | "RUNTIME_EXPIRED" | "ACTIVE_STEP" | "STEP_MISMATCH" | "REFERENCE_LIMIT" | "AUTHORIZATION_REQUIRED", message: string) {
    super(message);
    this.name = "TaskRunError";
  }
}

const TERMINAL_STATES = new Set<TaskRunState>(["completed", "cancelled", "expired"]);

function bounded(value: string, max: number, name: string, allowEmpty = false): string {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && !text) || text.length > max) throw new Error(`${name} is empty or exceeds ${max} characters.`);
  return text;
}

const DURABLE_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{16,}/i,
  /\b(?:api[_-]?key|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|companion[_-]?secret)\s*[:=]\s*[^\s,;]{4,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /https?:\/\/[^\/\s:@]+:[^@\s]+@/i,
];

function durableText(value: string, max: number, name: string, allowEmpty = false): string {
  const text = bounded(value, max, name, allowEmpty);
  if (DURABLE_SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new Error(`${name} appears to contain credentials or secret material and cannot be stored in durable task memory.`);
  return text;
}

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(16).toString("hex")}`;
}

export class TaskRunManager {
  private readonly roots: string[];
  private readonly maxReferences: number;
  private readonly maxCheckpointHistory: number;
  private readonly maxStepHistory: number;
  private readonly now: () => number;
  private completionGuard: ((taskRunId: string) => { allowed: boolean; reason?: string }) | null = null;
  private authorizationsRevokedTotal = 0;
  private capabilityLeasesRevokedTotal = 0;
  private locksReleasedTotal = 0;
  private reservationsReleasedTotal = 0;
  readonly authorizations: TaskAuthorizationService;

  constructor(readonly store: Store, options: TaskRunManagerOptions = {}) {
    this.roots = (options.roots ?? []).map((root) => resolve(root));
    this.maxReferences = Math.max(1, Math.min(options.maxReferences ?? 100, 1000));
    this.maxCheckpointHistory = Math.max(1, Math.min(options.maxCheckpointHistory ?? 20, 200));
    this.maxStepHistory = Math.max(1, Math.min(options.maxStepHistory ?? 100, 1000));
    this.now = options.now ?? Date.now;
    this.initSchema();
    this.authorizations = new TaskAuthorizationService(store);
    this.expireDue();
  }

  create(input: { objective: string; root?: string; maxSteps?: number; maxRuntimeMs?: number }): TaskRunView {
    const objective = durableText(input.objective, 20_000, "objective");
    const root = input.root ? this.validateRoot(input.root) : null;
    const maxSteps = Math.max(1, Math.min(Math.floor(input.maxSteps ?? 20), 100));
    const maxRuntimeMs = Math.max(1_000, Math.min(Math.floor(input.maxRuntimeMs ?? 2 * 60 * 60_000), 24 * 60 * 60_000));
    const now = this.now();
    const id = randomId("task");
    const createdAt = new Date(now).toISOString();
    const deadlineAt = new Date(now + maxRuntimeMs).toISOString();
    this.store.db.prepare(`INSERT INTO agent_runs(id,objective,root,state,max_steps,max_runtime_ms,step_count,active_step_id,checkpoint_seq,created_at,updated_at,deadline_at)
      VALUES(?,?,?,?,?,?,0,NULL,0,?,?,?)`).run(id, objective, root, "planned", maxSteps, maxRuntimeMs, createdAt, createdAt, deadlineAt);
    return this.get(id);
  }

  setCompletionGuard(guard: ((taskRunId: string) => { allowed: boolean; reason?: string }) | null) {
    this.completionGuard = guard;
  }

  authorize(id: string, input: { maxRiskLevel?: TaskAuthorizationRisk; ttlMinutes?: number }): TaskAuthorizationView {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (TERMINAL_STATES.has(state)) throw new TaskRunError("INVALID_STATE", `Task run is ${state}; it cannot receive a task authorization.`);
    this.assertBudget(run);
    const ttlMinutes = Math.max(1, Math.min(Math.floor(input.ttlMinutes ?? 120), 24 * 60));
    const expiry = new Date(Math.min(this.now() + ttlMinutes * 60_000, Date.parse(String(run.deadline_at)))).toISOString();
    return this.authorizations.authorize(id, input.maxRiskLevel ?? "high", expiry);
  }

  revokeAuthorization(id: string) {
    this.row(id);
    return this.authorizations.revoke(id);
  }

  grantCapability(id: string, input: { appScope: string; actions: string[]; maxCount?: number; ttlMinutes?: number }) {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (TERMINAL_STATES.has(state)) throw new TaskRunError("INVALID_STATE", `Task run is ${state}; it cannot receive a capability lease.`);
    this.assertBudget(run);
    const highActions = new Set(["delete","upload","download","restart","external_protocol"]);
    const requiredRisk: TaskAuthorizationRisk = input.actions.some((action) => highActions.has(String(action).toLowerCase())) ? "high" : "moderate";
    if (!this.authorizations.allows(id, requiredRisk)) throw new TaskRunError("AUTHORIZATION_REQUIRED", `Capability lease requires active ${requiredRisk} task authorization.`);
    const ttlMinutes = Math.max(1, Math.min(Math.floor(input.ttlMinutes ?? 10), 24 * 60));
    const expiry = new Date(Math.min(this.now() + ttlMinutes * 60_000, Date.parse(String(run.deadline_at)))).toISOString();
    return this.authorizations.grantCapability(id, { appScope: input.appScope, actions: input.actions, maxCount: input.maxCount, expiresAt: expiry });
  }

  revokeCapability(id: string, leaseId?: string) {
    this.row(id);
    return this.authorizations.revokeCapability(id, leaseId);
  }

  listCapabilities(id: string) {
    this.row(id);
    return this.authorizations.activeCapabilities(id);
  }

  get(id: string): TaskRunView {
    this.expireDue();
    const row = this.row(id);
    return this.view(row);
  }

  stats() {
    this.expireDue();
    const rows = this.store.db.prepare("SELECT state,COUNT(*) AS count FROM agent_runs GROUP BY state").all() as { state: string; count: number }[];
    const byState: Record<string, number> = {};
    let total = 0;
    for (const row of rows) { byState[String(row.state)] = Number(row.count); total += Number(row.count); }
    return {
      total,
      byState,
      active: (byState.running ?? 0) + (byState.waiting_confirmation ?? 0),
      paused: byState.paused ?? 0,
      authorizations: this.authorizations.stats(),
      governanceHygiene: {
        authorizationsRevokedTotal: this.authorizationsRevokedTotal,
        capabilityLeasesRevokedTotal: this.capabilityLeasesRevokedTotal,
        locksReleasedTotal: this.locksReleasedTotal,
        reservationsReleasedTotal: this.reservationsReleasedTotal,
      },
    };
  }

  list(state?: TaskRunState, limit = 50): TaskRunView[] {
    this.expireDue();
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 200));
    const rows = state
      ? this.store.db.prepare("SELECT * FROM agent_runs WHERE state=? ORDER BY updated_at DESC LIMIT ?").all(state, boundedLimit)
      : this.store.db.prepare("SELECT * FROM agent_runs ORDER BY updated_at DESC LIMIT ?").all(boundedLimit);
    return (rows as Record<string, unknown>[]).map((row) => this.view(row));
  }

  protocolTask(id: string): McpTaskProjection {
    return this.protocolProjection(this.get(id));
  }

  agentCycle(id: string): AgentCycleDirective {
    const run = this.get(id);
    const protocolTask = this.protocolProjection(run);
    const activeStep = run.activeStepId ? run.steps.find((step) => step.id === run.activeStepId) ?? null : null;
    const latestCheckpoint = run.checkpoints.at(-1);
    const nextAction = latestCheckpoint?.nextAction ?? "";
    const safety = { executeActions: false as const, replayAmbiguousActions: false as const, taskMetadataIsAuthorization: false as const };
    if (["completed", "failed", "cancelled", "expired"].includes(run.state)) {
      return { taskId: run.id, phase: "terminal", recommendedOperation: "none", message: `Task is ${run.state}.`, nextAction: "", activeStep, protocolTask, safety };
    }
    if (run.state === "waiting_confirmation" || run.state === "paused") {
      return { taskId: run.id, phase: "input_required", recommendedOperation: "confirm_or_resume", message: protocolTask.statusMessage ?? "Task requires client input before continuing.", nextAction, activeStep, protocolTask, safety };
    }
    if (activeStep) {
      return { taskId: run.id, phase: "await_action_verification", recommendedOperation: "verify_current_step", message: "An action step is active. Execute it through its routed tool exactly once, verify the post-condition, then record the outcome. Never replay an ambiguous action.", nextAction, activeStep, protocolTask, safety };
    }
    const message = run.stepCount >= run.maxSteps
      ? "Step budget is exhausted; close the task as completed or failed from verified evidence."
      : "No step is active. The agent may plan and begin the next bounded step.";
    return { taskId: run.id, phase: "ready_for_next_step", recommendedOperation: "begin_step", message, nextAction, activeStep: null, protocolTask, safety };
  }

  start(id: string): TaskRunView {
    const run = this.row(id);
    this.assertBudget(run);
    const state = String(run.state) as TaskRunState;
    if (state !== "planned" && state !== "paused") throw new TaskRunError("INVALID_STATE", `Task run is ${state}; it cannot be started/resumed.`);
    if (run.active_step_id) throw new TaskRunError("ACTIVE_STEP", "Task run already has an active step.");
    this.updateRun(id, { state: "running" });
    return this.get(id);
  }

  beginStep(id: string, input: { route: string; description: string; requiresConfirmation?: boolean }): TaskRunView {
    const run = this.row(id);
    this.assertBudget(run);
    const state = String(run.state) as TaskRunState;
    if (state !== "running") throw new TaskRunError("INVALID_STATE", `Task run is ${state}; a step can begin only while running.`);
    if (run.active_step_id) throw new TaskRunError("ACTIVE_STEP", "Task run already has an active step.");
    const stepCount = Number(run.step_count);
    const maxSteps = Number(run.max_steps);
    if (stepCount >= maxSteps) throw new TaskRunError("STEP_LIMIT", `Task run step budget exhausted (${maxSteps}).`);
    const route = durableText(input.route, 200, "route");
    const description = durableText(input.description, 2_000, "description");
    const requiresConfirmation = Boolean(input.requiresConfirmation);
    const stepId = randomId("step");
    const sequence = stepCount + 1;
    const now = new Date(this.now()).toISOString();
    const stepState: TaskStepState = requiresConfirmation ? "waiting_confirmation" : "running";
    const runState: TaskRunState = requiresConfirmation ? "waiting_confirmation" : "running";
    this.transaction(() => {
      this.store.db.prepare(`INSERT INTO agent_run_steps(id,run_id,sequence,route,description,state,requires_confirmation,receipt_id,note,started_at,completed_at)
        VALUES(?,?,?,?,?,?,?,NULL,NULL,?,NULL)`).run(stepId, id, sequence, route, description, stepState, requiresConfirmation ? 1 : 0, now);
      this.store.db.prepare("UPDATE agent_runs SET state=?,step_count=?,active_step_id=?,updated_at=? WHERE id=?")
        .run(runState, sequence, stepId, now, id);
    });
    return this.get(id);
  }

  confirmStep(id: string, stepId: string): TaskRunView {
    const run = this.row(id);
    this.assertBudget(run);
    if (String(run.state) !== "waiting_confirmation" || String(run.active_step_id ?? "") !== stepId) throw new TaskRunError("STEP_MISMATCH", "Task step is not waiting for confirmation.");
    const step = this.stepRow(stepId);
    if (String(step.state) !== "waiting_confirmation") throw new TaskRunError("STEP_MISMATCH", "Task step is not waiting for confirmation.");
    const now = new Date(this.now()).toISOString();
    this.transaction(() => {
      this.store.db.prepare("UPDATE agent_run_steps SET state='running' WHERE id=?").run(stepId);
      this.store.db.prepare("UPDATE agent_runs SET state='running',updated_at=? WHERE id=?").run(now, id);
    });
    return this.get(id);
  }

  completeStep(id: string, stepId: string, input: { verified: boolean; outcome: "success" | "failed"; receiptId?: string; note?: string }): TaskRunView {
    const run = this.row(id);
    const activeStepId = String(run.active_step_id ?? "");
    if (!activeStepId || activeStepId !== stepId) throw new TaskRunError("STEP_MISMATCH", "Task step does not match the active step.");
    if (String(run.state) !== "running") throw new TaskRunError("INVALID_STATE", `Task run is ${String(run.state)}; active step cannot be completed.`);
    const step = this.stepRow(stepId);
    if (String(step.state) !== "running") throw new TaskRunError("STEP_MISMATCH", "Task step is not executing.");
    const receiptId = input.receiptId ? durableText(input.receiptId, 500, "receiptId") : null;
    const note = input.note ? durableText(input.note, 2_000, "note") : null;
    const success = input.outcome === "success" && input.verified;
    const stepState: TaskStepState = success ? "verified" : "failed";
    const runState: TaskRunState = success ? "running" : "failed";
    const now = new Date(this.now()).toISOString();
    this.transaction(() => {
      this.store.db.prepare("UPDATE agent_run_steps SET state=?,receipt_id=?,note=?,completed_at=? WHERE id=?")
        .run(stepState, receiptId, note, now, stepId);
      this.store.db.prepare("UPDATE agent_runs SET state=?,active_step_id=NULL,updated_at=? WHERE id=?")
        .run(runState, now, id);
      if (runState === "failed") {
        this.releaseInactiveTaskGovernance(id, "step_failed");
      }
    });
    return this.get(id);
  }

  checkpoint(id: string, input: { summary: string; nextAction?: string }): TaskRunView {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (TERMINAL_STATES.has(state)) throw new TaskRunError("INVALID_STATE", `Task run is ${state}; it cannot be checkpointed.`);
    if (run.active_step_id) throw new TaskRunError("ACTIVE_STEP", "Checkpointing is blocked while a step is active.");
    const summary = durableText(input.summary, 20_000, "checkpoint summary");
    const nextAction = input.nextAction ? durableText(input.nextAction, 4_000, "next action") : "";
    const sequence = Number(run.checkpoint_seq) + 1;
    const now = new Date(this.now()).toISOString();
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO agent_run_checkpoints(run_id,sequence,summary,next_action,created_at) VALUES(?,?,?,?,?)")
        .run(id, sequence, summary, nextAction, now);
      this.store.db.prepare("UPDATE agent_runs SET checkpoint_seq=?,updated_at=? WHERE id=?").run(sequence, now, id);
      const cutoff = sequence - this.maxCheckpointHistory;
      if (cutoff > 0) this.store.db.prepare("DELETE FROM agent_run_checkpoints WHERE run_id=? AND sequence<=?").run(id, cutoff);
    });
    return this.get(id);
  }

  addReference(id: string, input: { kind: TaskReferenceKind; label: string; location: string; fingerprint?: string }): TaskRunView {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (TERMINAL_STATES.has(state)) throw new TaskRunError("INVALID_STATE", `Task run is ${state}; references are frozen.`);
    const count = this.store.db.prepare("SELECT COUNT(*) AS count FROM agent_run_refs WHERE run_id=?").get(id) as { count: number };
    if (Number(count.count) >= this.maxReferences) throw new TaskRunError("REFERENCE_LIMIT", `Task run reference limit reached (${this.maxReferences}).`);
    const kind = input.kind;
    const label = durableText(input.label, 500, "reference label");
    const location = durableText(input.location, 5_000, "reference location");
    const fingerprint = input.fingerprint ? durableText(input.fingerprint, 500, "reference fingerprint") : null;
    const refId = randomId("ref");
    const now = new Date(this.now()).toISOString();
    this.store.db.prepare("INSERT INTO agent_run_refs(id,run_id,kind,label,location,fingerprint,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(refId, id, kind, label, location, fingerprint, now);
    this.updateRun(id, {});
    return this.get(id);
  }

  pause(id: string): TaskRunView {
    const run = this.row(id);
    if (String(run.state) !== "running") throw new TaskRunError("INVALID_STATE", `Task run is ${String(run.state)}; only running tasks can be paused.`);
    if (run.active_step_id) throw new TaskRunError("ACTIVE_STEP", "Cannot pause while a step is active; resolve/interupt the step first.");
    this.transaction(() => {
      this.updateRun(id, { state: "paused" });
      this.releaseTaskExecutionResources(id, "task_paused");
    });
    return this.get(id);
  }

  completeRun(id: string): TaskRunView {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (state !== "running" && state !== "paused") throw new TaskRunError("INVALID_STATE", `Task run is ${state}; it cannot be completed.`);
    if (run.active_step_id) throw new TaskRunError("ACTIVE_STEP", "Cannot complete a task while a step is active.");
    const guard = this.completionGuard?.(id);
    if (guard && !guard.allowed) throw new TaskRunError("INVALID_STATE", guard.reason ?? "Task is bound to an incomplete multi-phase plan.");
    this.transaction(() => {
      this.updateRun(id, { state: "completed" });
      this.releaseInactiveTaskGovernance(id, "task_completed");
    });
    return this.get(id);
  }

  reconcileExpiredCompletion(id: string, note = "Memory reconciler normalized an expired task to completed from verified completion evidence."): TaskRunView {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (state === "completed") return this.get(id);
    if (state !== "expired") throw new TaskRunError("INVALID_STATE", `Task run is ${state}; only expired tasks can be reconciled to completed.`);
    if (run.active_step_id) throw new TaskRunError("ACTIVE_STEP", "Cannot reconcile an expired task while a step is active.");
    const summary = durableText(note, 2_000, "reconciliation note");
    const now = new Date(this.now()).toISOString();
    const checkpointSequence = Number(run.checkpoint_seq) + 1;
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO agent_run_checkpoints(run_id,sequence,summary,next_action,created_at) VALUES(?,?,?,?,?)")
        .run(id, checkpointSequence, summary, "", now);
      this.store.db.prepare("UPDATE agent_runs SET state='completed',checkpoint_seq=?,updated_at=? WHERE id=?")
        .run(checkpointSequence, now, id);
      this.releaseInactiveTaskGovernance(id, "reconciled_completed");
    });
    return this.get(id);
  }

  failRun(id: string, note = "Task run failed."): TaskRunView {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (TERMINAL_STATES.has(state)) throw new TaskRunError("INVALID_STATE", `Task run is ${state}.`);
    const now = new Date(this.now()).toISOString();
    this.transaction(() => {
      if (run.active_step_id) {
        this.store.db.prepare("UPDATE agent_run_steps SET state='interrupted',note=?,completed_at=? WHERE id=?")
          .run(durableText(note, 2_000, "failure note"), now, String(run.active_step_id));
      }
      this.store.db.prepare("UPDATE agent_runs SET state='failed',active_step_id=NULL,updated_at=? WHERE id=?").run(now, id);
      this.releaseInactiveTaskGovernance(id, "task_failed");
    });
    return this.get(id);
  }

  cancel(id: string, note = "Task run cancelled."): TaskRunView {
    const run = this.row(id);
    const state = String(run.state) as TaskRunState;
    if (TERMINAL_STATES.has(state)) throw new TaskRunError("INVALID_STATE", `Task run is already ${state}.`);
    const now = new Date(this.now()).toISOString();
    this.transaction(() => {
      if (run.active_step_id) {
        this.store.db.prepare("UPDATE agent_run_steps SET state='interrupted',note=?,completed_at=? WHERE id=?")
          .run(durableText(note, 2_000, "cancel note"), now, String(run.active_step_id));
      }
      this.store.db.prepare("UPDATE agent_runs SET state='cancelled',active_step_id=NULL,updated_at=? WHERE id=?").run(now, id);
      this.releaseInactiveTaskGovernance(id, "task_cancelled");
    });
    return this.get(id);
  }

  pauseForEmergencyStop(note = "Emergency Stop enabled."): number {
    const safeNote = durableText(note, 2_000, "Emergency Stop note");
    const now = new Date(this.now()).toISOString();
    const rows = this.store.db.prepare("SELECT * FROM agent_runs WHERE state IN ('running','waiting_confirmation')").all() as Record<string, unknown>[];
    let paused = 0;
    for (const run of rows) {
      const runId = String(run.id);
      this.transaction(() => {
        if (run.active_step_id) {
          this.store.db.prepare("UPDATE agent_run_steps SET state='interrupted',note=?,completed_at=? WHERE id=?")
            .run(safeNote + " Active step outcome is unresolved and must not be replayed automatically.", now, String(run.active_step_id));
        }
        this.store.db.prepare("UPDATE agent_runs SET state='paused',active_step_id=NULL,updated_at=? WHERE id=?")
          .run(now, runId);
        this.releaseInactiveTaskGovernance(runId, "emergency_stop");
      });
      paused += 1;
    }
    if (typeof (this.store as { purgeAllEphemeralResources?: (reason: string) => { locksReleased: number; reservationsReleased: number } }).purgeAllEphemeralResources === "function") {
      const purged = this.store.purgeAllEphemeralResources("emergency_stop");
      this.locksReleasedTotal += purged.locksReleased;
      this.reservationsReleasedTotal += purged.reservationsReleased;
    }
    return paused;
  }

  expireDue(): number {
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const rows = this.store.db.prepare("SELECT * FROM agent_runs WHERE state NOT IN ('completed','cancelled','expired') AND deadline_at<=?").all(now) as Record<string, unknown>[];
    let expired = 0;
    for (const run of rows) {
      const runId = String(run.id);
      this.transaction(() => {
        if (run.active_step_id) {
          this.store.db.prepare("UPDATE agent_run_steps SET state='interrupted',note=?,completed_at=? WHERE id=?")
            .run("Task runtime budget expired while the step outcome was unresolved.", now, String(run.active_step_id));
        }
        this.store.db.prepare("UPDATE agent_runs SET state='expired',active_step_id=NULL,updated_at=? WHERE id=?").run(now, runId);
        this.releaseInactiveTaskGovernance(runId, "runtime_expired");
      });
      expired += 1;
    }
    return expired;
  }

  recoverAfterRestart(): number {
    const now = new Date(this.now()).toISOString();
    const rows = this.store.db.prepare("SELECT * FROM agent_runs WHERE state IN ('running','waiting_confirmation')").all() as Record<string, unknown>[];
    let recovered = 0;
    for (const run of rows) {
      const runId = String(run.id);
      this.transaction(() => {
        if (run.active_step_id) {
          this.store.db.prepare("UPDATE agent_run_steps SET state='interrupted',note=?,completed_at=? WHERE id=?")
            .run("Workstation runtime restarted while this step was active; outcome is ambiguous and must not be replayed automatically.", now, String(run.active_step_id));
        }
        this.store.db.prepare("UPDATE agent_runs SET state='paused',active_step_id=NULL,updated_at=? WHERE id=?")
          .run(now, runId);
        this.releaseInactiveTaskGovernance(runId, "restart_recovery");
      });
      recovered += 1;
    }
    if (typeof (this.store as { purgeAllEphemeralResources?: (reason: string) => { locksReleased: number; reservationsReleased: number } }).purgeAllEphemeralResources === "function") {
      const purged = this.store.purgeAllEphemeralResources("restart_recovery");
      this.locksReleasedTotal += purged.locksReleased;
      this.reservationsReleasedTotal += purged.reservationsReleased;
    }
    return recovered;
  }

  private releaseTaskExecutionResources(runId: string, reason: string) {
    try {
      const hasLocks = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_resource_locks'").get();
      const hasReservations = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_lane_reservations'").get();
      const locksReleased = hasLocks ? Number(this.store.db.prepare("DELETE FROM execution_resource_locks WHERE task_run_id=?").run(runId).changes ?? 0) : 0;
      const reservationsReleased = hasReservations ? Number(this.store.db.prepare("DELETE FROM execution_lane_reservations WHERE task_run_id=?").run(runId).changes ?? 0) : 0;
      this.locksReleasedTotal += locksReleased;
      this.reservationsReleasedTotal += reservationsReleased;
      if (locksReleased > 0 || reservationsReleased > 0) {
        this.store.audit("task_governance_hygiene", "execution_resources_released", { runId, reason, locksReleased, reservationsReleased });
      }
    } catch {}
  }

  private releaseInactiveTaskGovernance(runId: string, reason: string) {
    try {
      const revoked = this.authorizations.revoke(runId);
      if (revoked.revoked) this.authorizationsRevokedTotal += 1;
      this.capabilityLeasesRevokedTotal += revoked.capabilityLeasesRevoked;
    } catch {}
    this.releaseTaskExecutionResources(runId, reason);
  }

  private initSchema() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs(
        id TEXT PRIMARY KEY, objective TEXT NOT NULL, root TEXT, state TEXT NOT NULL,
        max_steps INTEGER NOT NULL, max_runtime_ms INTEGER NOT NULL, step_count INTEGER NOT NULL DEFAULT 0,
        active_step_id TEXT, checkpoint_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deadline_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_run_steps(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, route TEXT NOT NULL,
        description TEXT NOT NULL, state TEXT NOT NULL, requires_confirmation INTEGER NOT NULL DEFAULT 0,
        receipt_id TEXT, note TEXT, started_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run ON agent_run_steps(run_id,sequence);
      CREATE TABLE IF NOT EXISTS agent_run_checkpoints(
        run_id TEXT NOT NULL, sequence INTEGER NOT NULL, summary TEXT NOT NULL, next_action TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(run_id,sequence)
      );
      CREATE TABLE IF NOT EXISTS agent_run_refs(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
        location TEXT NOT NULL, fingerprint TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_refs_run ON agent_run_refs(run_id,created_at);
    `);
  }

  private row(id: string): Record<string, unknown> {
    this.expireDue();
    const row = this.store.db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new TaskRunError("NOT_FOUND", "Task run was not found.");
    return row;
  }

  private stepRow(id: string): Record<string, unknown> {
    const row = this.store.db.prepare("SELECT * FROM agent_run_steps WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new TaskRunError("STEP_MISMATCH", "Task step was not found.");
    return row;
  }

  private assertBudget(run: Record<string, unknown>) {
    if (Date.parse(String(run.deadline_at)) <= this.now()) {
      this.expireDue();
      throw new TaskRunError("RUNTIME_EXPIRED", "Task run runtime budget expired.");
    }
    if (Number(run.step_count) >= Number(run.max_steps) && !run.active_step_id) throw new TaskRunError("STEP_LIMIT", `Task run step budget exhausted (${Number(run.max_steps)}).`);
  }

  private validateRoot(input: string): string {
    if (!isAbsolute(input)) throw new TaskRunError("INVALID_ROOT", "Task run root must be an absolute path.");
    const root = resolve(input);
    if (!this.roots.length) return root;
    const allowed = this.roots.some((candidate) => {
      const rel = relative(candidate, root);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!allowed) throw new TaskRunError("INVALID_ROOT", "Task run root is outside configured roots.");
    return root;
  }

  private updateRun(id: string, changes: { state?: TaskRunState }) {
    const now = new Date(this.now()).toISOString();
    if (changes.state) this.store.db.prepare("UPDATE agent_runs SET state=?,updated_at=? WHERE id=?").run(changes.state, now, id);
    else this.store.db.prepare("UPDATE agent_runs SET updated_at=? WHERE id=?").run(now, id);
  }

  private view(row: Record<string, unknown>): TaskRunView {
    const id = String(row.id);
    const checkpoints = (this.store.db.prepare("SELECT sequence,summary,next_action,created_at FROM agent_run_checkpoints WHERE run_id=? ORDER BY sequence DESC LIMIT ?").all(id, this.maxCheckpointHistory) as Record<string, unknown>[])
      .reverse().map((cp) => ({ sequence: Number(cp.sequence), summary: String(cp.summary), nextAction: String(cp.next_action), createdAt: String(cp.created_at) }));
    const references = (this.store.db.prepare("SELECT id,kind,label,location,fingerprint,created_at FROM agent_run_refs WHERE run_id=? ORDER BY created_at ASC LIMIT ?").all(id, this.maxReferences) as Record<string, unknown>[])
      .map((ref) => ({ id: String(ref.id), kind: String(ref.kind) as TaskReferenceKind, label: String(ref.label), location: String(ref.location), fingerprint: ref.fingerprint == null ? null : String(ref.fingerprint), createdAt: String(ref.created_at) }));
    const steps = (this.store.db.prepare("SELECT id,sequence,route,description,state,requires_confirmation,receipt_id,note,started_at,completed_at FROM agent_run_steps WHERE run_id=? ORDER BY sequence DESC LIMIT ?").all(id, this.maxStepHistory) as Record<string, unknown>[])
      .reverse().map((step) => ({ id: String(step.id), sequence: Number(step.sequence), route: String(step.route), description: String(step.description), state: String(step.state) as TaskStepState, requiresConfirmation: Number(step.requires_confirmation) === 1, receiptId: step.receipt_id == null ? null : String(step.receipt_id), note: step.note == null ? null : String(step.note), startedAt: String(step.started_at), completedAt: step.completed_at == null ? null : String(step.completed_at) }));
    return {
      id,
      objective: String(row.objective),
      root: row.root == null ? null : String(row.root),
      state: String(row.state) as TaskRunState,
      maxSteps: Number(row.max_steps),
      maxRuntimeMs: Number(row.max_runtime_ms),
      stepCount: Number(row.step_count),
      activeStepId: row.active_step_id == null ? null : String(row.active_step_id),
      checkpointSequence: Number(row.checkpoint_seq),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deadlineAt: String(row.deadline_at),
      checkpoints,
      references,
      steps,
      authorization: this.authorizations.active(id),
    };
  }

  private protocolProjection(run: TaskRunView): McpTaskProjection {
    const activeStep = run.activeStepId ? run.steps.find((step) => step.id === run.activeStepId) ?? null : null;
    const latestCheckpoint = run.checkpoints.at(-1);
    const verifiedSteps = run.steps.filter((step) => step.state === "verified").length;
    const base = {
      resultType: "complete" as const,
      taskId: run.id,
      createdAt: run.createdAt,
      lastUpdatedAt: run.updatedAt,
      ttlMs: run.maxRuntimeMs,
      pollIntervalMs: 1000,
      adapterOnly: true as const,
    };
    const statusMessage = activeStep?.description || latestCheckpoint?.nextAction || `Durable task is ${run.state}.`;
    if (run.state === "completed") {
      return { ...base, status: "completed", statusMessage, result: { taskId: run.id, objective: run.objective, verifiedSteps, stepCount: run.stepCount, latestCheckpoint: latestCheckpoint?.summary ?? "" } };
    }
    if (run.state === "cancelled") return { ...base, status: "cancelled", statusMessage };
    if (run.state === "failed" || run.state === "expired") {
      const note = [...run.steps].reverse().find((step) => step.state === "failed" || step.state === "interrupted")?.note;
      return { ...base, status: "failed", statusMessage: note || statusMessage, error: { code: run.state === "expired" ? -32001 : -32603, message: run.state === "expired" ? "Durable task runtime expired." : "Durable task failed.", data: { taskId: run.id, state: run.state } } };
    }
    if (run.state === "waiting_confirmation" || run.state === "paused") {
      const key = run.state === "waiting_confirmation" && activeStep ? `confirm-${activeStep.id}` : `resume-${run.id}`;
      const message = run.state === "waiting_confirmation"
        ? "This durable task step is waiting for task-state confirmation. The routed workstation action still keeps its own safety/authorization requirements."
        : "This durable task is paused. Confirm whether it should resume from the latest verified state; interrupted actions must not be replayed automatically.";
      return {
        ...base,
        status: "input_required",
        statusMessage: message,
        inputRequests: {
          [key]: { method: "elicitation/create", params: { mode: "form", message, requestedSchema: { type: "object", properties: { proceed: { type: "boolean", title: "Proceed" } }, required: ["proceed"] } } },
        },
      };
    }
    return { ...base, status: "working", statusMessage };
  }

  private transaction<T>(fn: () => T): T {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.store.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
}



