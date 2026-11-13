import { cpus } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./db.js";
import { BACKGROUND_LANE_CAPABILITIES, BACKGROUND_LANE_FORBIDDEN } from "./capability-registry.js";
import {
  ACTIVE_LOCK_TASK_STATES,
  canonicalizeResourceKey,
  canonicalizeResourceList,
  describeFileResourceIdentity,
  describeResourceIdentity,
} from "./resource-guard.js";

export {
  ACTIVE_LOCK_TASK_STATES,
  canonicalizeResourceKey,
  canonicalizeResourceList,
  describeFileResourceIdentity,
  describeResourceIdentity,
};

export type ExecutionLane = "background" | "isolated";
export type ExecutionPreference = "auto" | ExecutionLane;
export type ResourceLockMode = "read" | "write" | "exclusive";

export type IsolatedLaneStatus = {
  provider: string;
  featureAvailable: boolean;
  configured: boolean;
  online: boolean;
  busy?: boolean;
  lastHeartbeatAt?: string | null;
  detail?: string;
};

export type ExecutionRouteRequest = {
  preferred?: ExecutionPreference;
  domain?: "files" | "office" | "browser" | "desktop" | "terminal" | "pdf" | "intake" | "mixed";
  operation?: string;
  requiresGui?: boolean;
  requiresForeground?: boolean;
  requiresVisual?: boolean;
  dragDrop?: boolean;
  canvas?: boolean;
  nativeDialog?: boolean;
  description?: string;
};

export type ExecutionRoutePlan = {
  lane: ExecutionLane;
  preferred: ExecutionPreference;
  available: boolean;
  reason: string;
  hostForegroundAllowed: false;
  escalation: "none" | "isolated_if_needed";
  constraints: string[];
};

export type ResourceLock = {
  id: string;
  resource: string;
  canonicalPath?: string;
  physicalId?: string | null;
  ownerKind?: "task" | "ephemeral";
  mode: ResourceLockMode;
  taskRunId: string;
  lane: ExecutionLane;
  expiresAt: string;
  createdAt: string;
  renewed?: boolean;
  upgraded?: boolean;
};

export type LaneReservation = {
  id: string;
  taskRunId: string;
  stepId: string | null;
  lane: ExecutionLane;
  expiresAt: string;
  createdAt: string;
  renewed?: boolean;
};

export type ArtifactHandoff = {
  id: string;
  taskRunId: string;
  fromLane: ExecutionLane;
  toLane: ExecutionLane;
  state: "open" | "completed" | "cancelled";
  root: string;
  inputDir: string;
  outputDir: string;
  createdAt: string;
  updatedAt: string;
};

function id(prefix: string) { return `${prefix}-${randomBytes(12).toString("hex")}`; }
function bounded(value: unknown, max: number, name: string) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new Error(`${name} is empty or exceeds ${max} characters.`);
  return text;
}
function safeSegment(value: string) { return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120); }

function isSqliteBusy(error: unknown) {
  const detail = error as { errcode?: number; errstr?: string; message?: string };
  return detail?.errcode === 5 || detail?.errcode === 6 || /database is (?:locked|busy)/i.test(String(detail?.errstr || detail?.message || error));
}

export class ExecutionLaneService {
  readonly exchangeRoot: string;
  readonly backgroundConcurrency = Math.max(2, Math.min(Number(process.env.NHD_BACKGROUND_CONCURRENCY ?? Math.floor(Math.max(2, cpus().length) / 2)), 6));
  readonly isolatedConcurrency = 1;
  private orphanLocksReleasedTotal = 0;
  private orphanReservationsReleasedTotal = 0;

  constructor(readonly store: Store, exchangeRoot = process.env.NHD_AGENT_EXCHANGE_ROOT || (existsSync("D:\\") ? "D:\\NHD-Agent-Exchange" : resolve(process.cwd(), "NHD-Agent-Exchange"))) {
    this.exchangeRoot = resolve(exchangeRoot);
    mkdirSync(this.exchangeRoot, { recursive: true });
    this.initSchema();
    this.cleanupExpiredLocks();
  }

  plan(input: ExecutionRouteRequest, isolated: IsolatedLaneStatus): ExecutionRoutePlan {
    const preferred = input.preferred ?? "auto";
    const domain = input.domain ?? "mixed";
    const needsGui = Boolean(input.requiresGui || input.requiresForeground || input.requiresVisual || input.dragDrop || input.canvas || input.nativeDialog || domain === "desktop");
    const isolatedAvailable = isolated.featureAvailable && isolated.configured;

    if (preferred === "background") {
      if (needsGui) throw new Error("Background mode cannot execute a foreground/GUI-dependent step. Route this step to Isolated Agent instead.");
      return {
        lane: "background", preferred, available: true,
        reason: "The user forced Background mode and the step can be expressed without host foreground input.",
        hostForegroundAllowed: false, escalation: "none",
        constraints: this.backgroundConstraints(),
      };
    }
    if (preferred === "isolated") {
      return {
        lane: "isolated", preferred, available: isolatedAvailable,
        reason: isolatedAvailable ? "The user forced Isolated Agent mode." : "Isolated Agent was requested but its Windows isolation provider is not ready.",
        hostForegroundAllowed: false, escalation: "none",
        constraints: ["All GUI input stays inside the isolated environment.", "Host desktop input is never used as an isolated fallback."],
      };
    }
    if (needsGui) {
      return {
        lane: "isolated", preferred, available: isolatedAvailable,
        reason: "The step needs GUI/foreground/visual interaction, so it is isolated from the user's Windows session.",
        hostForegroundAllowed: false, escalation: "none",
        constraints: ["Never fall back to host desktop clicks.", "If the isolated environment is unavailable, pause/fail instead of stealing user focus."],
      };
    }
    return {
      lane: "background", preferred, available: true,
      reason: "The step can run through structured/background-capable tools without taking over the user's desktop.",
      hostForegroundAllowed: false, escalation: "isolated_if_needed",
      constraints: this.backgroundConstraints(),
    };
  }

  status(isolated: IsolatedLaneStatus) {
    this.cleanupExpiredLocks();
    this.cleanupExpiredReservations();
    const locks = this.listLocks();
    return {
      architecture: "background-first + isolated-on-demand + parallel",
      hostForegroundPolicy: "blocked",
      background: {
        state: "online",
        maxConcurrent: this.backgroundConcurrency,
        capabilities: [...BACKGROUND_LANE_CAPABILITIES],
        forbidden: [...BACKGROUND_LANE_FORBIDDEN],
      },
      isolated: { ...isolated, maxConcurrent: this.isolatedConcurrency },
      exchangeRoot: this.exchangeRoot,
      scheduler: {
        background: { maxConcurrent: this.backgroundConcurrency, active: this.listReservations("background").length, mode: "dynamic-turbo" },
        isolated: { maxConcurrent: this.isolatedConcurrency, active: this.listReservations("isolated").length },
        reservations: this.listReservations(),
      },
      locks: {
        active: locks.length,
        items: locks,
        allowedActiveTaskStates: [...ACTIVE_LOCK_TASK_STATES],
        hygiene: {
          orphanLocksReleasedTotal: this.orphanLocksReleasedTotal,
          orphanReservationsReleasedTotal: this.orphanReservationsReleasedTotal,
        },
      },
    };
  }

  reserve(input: { taskRunId: string; stepId?: string; lane: ExecutionLane; ttlSeconds?: number }): LaneReservation {
    this.cleanupExpiredReservations();
    const taskRunId = bounded(input.taskRunId, 256, "taskRunId");
    this.store.requireActiveTaskRun(taskRunId);
    const stepId = input.stepId ? bounded(input.stepId, 256, "stepId") : null;
    const limit = input.lane === "background" ? this.backgroundConcurrency : this.isolatedConcurrency;
    const ttlSeconds = Math.max(5, Math.min(Math.floor(input.ttlSeconds ?? 900), 24 * 60 * 60));
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const existing = this.store.db.prepare("SELECT * FROM execution_lane_reservations WHERE lane=? AND expires_at>? ORDER BY created_at").all(input.lane, new Date().toISOString()) as Record<string, unknown>[];
    const same = existing.find((row) => String(row.task_run_id) === taskRunId && String(row.step_id ?? "") === String(stepId ?? ""));
    if (same) {
      const sameId = String(same.id);
      this.store.db.prepare("UPDATE execution_lane_reservations SET expires_at=? WHERE id=?").run(expiresAt, sameId);
      this.store.audit("execution_lane", "renewed", { reservationId: sameId, taskRunId, stepId, lane: input.lane, expiresAt });
      return { ...this.reservationView(same), expiresAt, renewed: true };
    }
    if (existing.length >= limit) throw new Error(`${input.lane} lane is at capacity (${existing.length}/${limit}).`);
    const reservationId = id("lane");
    const createdAt = new Date().toISOString();
    this.store.db.prepare("INSERT INTO execution_lane_reservations(id,task_run_id,step_id,lane,expires_at,created_at) VALUES(?,?,?,?,?,?)")
      .run(reservationId, taskRunId, stepId, input.lane, expiresAt, createdAt);
    this.store.audit("execution_lane", "reserved", { reservationId, taskRunId, stepId, lane: input.lane, expiresAt });
    return { id: reservationId, taskRunId, stepId, lane: input.lane, expiresAt, createdAt };
  }

  releaseReservation(reservationIdInput: string, taskRunIdInput?: string) {
    const reservationId = bounded(reservationIdInput, 256, "reservationId");
    const callerTaskRunId = String(taskRunIdInput ?? "").trim();
    if (!callerTaskRunId) {
      throw new Error("taskRunId is required to release a lane reservation; ownerless release is forbidden.");
    }
    this.store.requireExistingTaskRun(callerTaskRunId);
    const row = this.store.db.prepare("SELECT task_run_id FROM execution_lane_reservations WHERE id=?").get(reservationId) as { task_run_id?: string } | undefined;
    if (!row) return { id: reservationId, released: false };
    if (String(row.task_run_id) !== callerTaskRunId) {
      this.store.audit("execution_lane", "release_denied", {
        reservationId,
        ownerTaskRunId: String(row.task_run_id),
        callerTaskRunId,
      });
      throw new Error(`Foreign reservation release denied: reservation '${reservationId}' belongs to task '${String(row.task_run_id)}', not '${callerTaskRunId}'.`);
    }
    const result = this.store.db.prepare("DELETE FROM execution_lane_reservations WHERE id=?").run(reservationId);
    const released = Number(result.changes ?? 0) > 0;
    this.store.audit("execution_lane", released ? "released" : "release_noop", { reservationId, taskRunId: callerTaskRunId });
    return { id: reservationId, released };
  }

  listReservations(lane?: ExecutionLane): LaneReservation[] {
    this.cleanupExpiredReservations();
    const now = new Date().toISOString();
    const rows = lane
      ? this.store.db.prepare("SELECT * FROM execution_lane_reservations WHERE lane=? AND expires_at>? ORDER BY created_at").all(lane, now)
      : this.store.db.prepare("SELECT * FROM execution_lane_reservations WHERE expires_at>? ORDER BY created_at").all(now);
    return (rows as Record<string, unknown>[]).map((row) => this.reservationView(row));
  }

  acquireLock(input: { resource: string; mode: ResourceLockMode; taskRunId: string; lane: ExecutionLane; ttlSeconds?: number }): ResourceLock {
    const resource = bounded(input.resource, 5_000, "resource");
    const taskRunId = bounded(input.taskRunId, 256, "taskRunId");
    const guarded = this.store.guardResources([resource], {
      mode: input.mode,
      taskRunId,
      lane: input.lane,
      ttlSeconds: input.ttlSeconds,
      operation: "execution_lock_acquire",
    });
    return guarded.locks[0]!;
  }

  acquireLocks(input: { resources: string[]; mode: ResourceLockMode; taskRunId: string; lane: ExecutionLane; ttlSeconds?: number }): { locks: ResourceLock[]; canonicalOrder: string[] } {
    if (!Array.isArray(input.resources) || input.resources.length === 0) {
      throw new Error("resources must be a non-empty array.");
    }
    const taskRunId = bounded(input.taskRunId, 256, "taskRunId");
    const guarded = this.store.guardResources(input.resources, {
      mode: input.mode,
      taskRunId,
      lane: input.lane,
      ttlSeconds: input.ttlSeconds,
      operation: "execution_lock_acquire_multi",
    });
    return { locks: guarded.locks, canonicalOrder: guarded.canonicalOrder };
  }

  guardResources(
    resources: readonly string[],
    options?: {
      mode?: ResourceLockMode;
      taskRunId?: string;
      payload?: Record<string, unknown> | null;
      lane?: ExecutionLane;
      ttlSeconds?: number;
      operation?: string;
    },
  ) {
    return this.store.guardResources(resources, options);
  }

  releaseTaskResources(taskRunIdInput: string, reason = "task_inactive") {
    const taskRunId = bounded(taskRunIdInput, 256, "taskRunId");
    let locksReleased = 0;
    let reservationsReleased = 0;
    try {
      const lockResult = this.store.db.prepare("DELETE FROM execution_resource_locks WHERE task_run_id=?").run(taskRunId);
      const reservationResult = this.store.db.prepare("DELETE FROM execution_lane_reservations WHERE task_run_id=?").run(taskRunId);
      locksReleased = Number(lockResult.changes ?? 0);
      reservationsReleased = Number(reservationResult.changes ?? 0);
      if (locksReleased > 0 || reservationsReleased > 0) {
        this.store.audit("execution_hygiene", "task_resources_released", { taskRunId, reason, locksReleased, reservationsReleased });
      }
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
    }
    return { taskRunId, reason, locksReleased, reservationsReleased };
  }

  reconcileOrphanedResources() {
    const { orphanLocksReleased, orphanReservationsReleased } = this.store.reconcileExpiredAndInactiveTaskResources();
    if (orphanLocksReleased > 0 || orphanReservationsReleased > 0) {
      this.orphanLocksReleasedTotal += orphanLocksReleased;
      this.orphanReservationsReleasedTotal += orphanReservationsReleased;
      this.store.audit("execution_hygiene", "orphans_reconciled", { orphanLocksReleased, orphanReservationsReleased });
    }
    return { orphanLocksReleased, orphanReservationsReleased };
  }

  releaseLock(lockIdInput: string, taskRunIdInput?: string) {
    const lockId = bounded(lockIdInput, 256, "lockId");
    const callerTaskRunId = String(taskRunIdInput ?? "").trim();
    if (!callerTaskRunId) {
      throw new Error("taskRunId is required to release a resource lock; ownerless release is forbidden.");
    }
    this.store.requireExistingTaskRun(callerTaskRunId);
    const row = this.store.db.prepare("SELECT task_run_id, resource, mode FROM execution_resource_locks WHERE id=?").get(lockId) as { task_run_id?: string; resource?: string; mode?: string } | undefined;
    if (!row) return { id: lockId, released: false };
    if (String(row.task_run_id) !== callerTaskRunId) {
      this.store.audit("execution_lock", "release_denied", {
        lockId,
        resource: String(row.resource ?? ""),
        ownerTaskRunId: String(row.task_run_id),
        callerTaskRunId,
      });
      throw new Error(`Foreign lock release denied: lock '${lockId}' belongs to task '${String(row.task_run_id)}', not '${callerTaskRunId}'.`);
    }
    const result = this.store.db.prepare("DELETE FROM execution_resource_locks WHERE id=?").run(lockId);
    const released = Number(result.changes ?? 0) > 0;
    this.store.audit("execution_lock", released ? "released" : "release_noop", { lockId, taskRunId: callerTaskRunId });
    return { id: lockId, released };
  }

  listLocks(): ResourceLock[] {
    this.cleanupExpiredLocks();
    const now = new Date().toISOString();
    return (this.store.db.prepare("SELECT * FROM execution_resource_locks WHERE expires_at>? ORDER BY created_at").all(now) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      resource: String(row.resource),
      canonicalPath: row.canonical_path ? String(row.canonical_path) : String(row.resource),
      physicalId: row.physical_id == null ? null : String(row.physical_id),
      ownerKind: (row.owner_kind ? String(row.owner_kind) : (String(row.task_run_id).startsWith("ephemeral:") ? "ephemeral" : "task")) as "task" | "ephemeral",
      mode: String(row.mode) as ResourceLockMode,
      taskRunId: String(row.task_run_id),
      lane: String(row.lane) as ExecutionLane,
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
    }));
  }

  createHandoff(input: { taskRunId: string; fromLane: ExecutionLane; toLane: ExecutionLane }): ArtifactHandoff {
    const taskRunId = bounded(input.taskRunId, 256, "taskRunId");
    if (input.fromLane === input.toLane) throw new Error("Artifact handoff requires different source and destination lanes.");
    const handoffId = id("handoff");
    const root = resolve(this.exchangeRoot, "tasks", safeSegment(taskRunId), handoffId);
    const inputDir = resolve(root, "input");
    const outputDir = resolve(root, "output");
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    const now = new Date().toISOString();
    this.store.db.prepare("INSERT INTO execution_handoffs(id,task_run_id,from_lane,to_lane,state,root,input_dir,output_dir,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(handoffId, taskRunId, input.fromLane, input.toLane, "open", root, inputDir, outputDir, now, now);
    this.store.audit("execution_handoff", "created", { handoffId, taskRunId, fromLane: input.fromLane, toLane: input.toLane, root });
    return { id: handoffId, taskRunId, fromLane: input.fromLane, toLane: input.toLane, state: "open", root, inputDir, outputDir, createdAt: now, updatedAt: now };
  }

  completeHandoff(handoffIdInput: string) { return this.setHandoffState(handoffIdInput, "completed"); }
  cancelHandoff(handoffIdInput: string) { return this.setHandoffState(handoffIdInput, "cancelled"); }

  getHandoff(handoffIdInput: string): ArtifactHandoff {
    const handoffId = bounded(handoffIdInput, 256, "handoffId");
    const row = this.store.db.prepare("SELECT * FROM execution_handoffs WHERE id=?").get(handoffId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Artifact handoff was not found.");
    return this.handoffView(row);
  }

  listHandoffs(taskRunId?: string): ArtifactHandoff[] {
    const rows = taskRunId
      ? this.store.db.prepare("SELECT * FROM execution_handoffs WHERE task_run_id=? ORDER BY created_at DESC LIMIT 100").all(taskRunId)
      : this.store.db.prepare("SELECT * FROM execution_handoffs ORDER BY created_at DESC LIMIT 100").all();
    return (rows as Record<string, unknown>[]).map((row) => this.handoffView(row));
  }

  private backgroundConstraints() {
    return [
      "Never inject host mouse or keyboard input.",
      "Never activate/switch host windows or foreground browser tabs.",
      "Use structured DOM, Office Direct, files, terminal, OCR/PDF or API paths.",
      "Escalate to Isolated Agent instead of using host visual/coordinate fallback.",
    ];
  }

  private cleanupExpiredLocks() {
    try {
      this.reconcileOrphanedResources();
      return true;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      console.warn("Execution resource-lock cleanup deferred because SQLite is busy.");
      return false;
    }
  }

  private cleanupExpiredReservations() {
    try {
      this.reconcileOrphanedResources();
      return true;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      console.warn("Execution reservation cleanup deferred because SQLite is busy.");
      return false;
    }
  }

  private reservationView(row: Record<string, unknown>): LaneReservation {
    return {
      id: String(row.id), taskRunId: String(row.task_run_id), stepId: row.step_id == null ? null : String(row.step_id),
      lane: String(row.lane) as ExecutionLane, expiresAt: String(row.expires_at), createdAt: String(row.created_at),
    };
  }

  private setHandoffState(handoffIdInput: string, state: "completed" | "cancelled") {
    const handoffId = bounded(handoffIdInput, 256, "handoffId");
    const now = new Date().toISOString();
    const result = this.store.db.prepare("UPDATE execution_handoffs SET state=?,updated_at=? WHERE id=? AND state='open'").run(state, now, handoffId);
    if (Number(result.changes ?? 0) === 0) throw new Error("Artifact handoff is missing or no longer open.");
    this.store.audit("execution_handoff", state, { handoffId });
    return this.getHandoff(handoffId);
  }

  private handoffView(row: Record<string, unknown>): ArtifactHandoff {
    return {
      id: String(row.id), taskRunId: String(row.task_run_id), fromLane: String(row.from_lane) as ExecutionLane,
      toLane: String(row.to_lane) as ExecutionLane, state: String(row.state) as ArtifactHandoff["state"],
      root: String(row.root), inputDir: String(row.input_dir), outputDir: String(row.output_dir),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private initSchema() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_lane_reservations(
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, step_id TEXT, lane TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_lane_reservations_lane ON execution_lane_reservations(lane,expires_at);
      CREATE INDEX IF NOT EXISTS idx_execution_lane_reservations_task ON execution_lane_reservations(task_run_id,expires_at);
      CREATE TABLE IF NOT EXISTS execution_resource_locks(
        id TEXT PRIMARY KEY, resource TEXT NOT NULL, mode TEXT NOT NULL,
        task_run_id TEXT NOT NULL, lane TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_resource_locks_resource ON execution_resource_locks(resource,expires_at);
      CREATE INDEX IF NOT EXISTS idx_execution_resource_locks_task ON execution_resource_locks(task_run_id,expires_at);
      CREATE TABLE IF NOT EXISTS execution_handoffs(
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, from_lane TEXT NOT NULL, to_lane TEXT NOT NULL,
        state TEXT NOT NULL, root TEXT NOT NULL, input_dir TEXT NOT NULL, output_dir TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_handoffs_task ON execution_handoffs(task_run_id,created_at);
    `);
  }
}
