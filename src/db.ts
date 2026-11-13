import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.js";
import { nowIso, randomToken, sha256 } from "./security.js";
import {
  ACTIVE_LOCK_TASK_STATES,
  createEphemeralOwnerId,
  describeResourceIdentity,
  getCurrentTaskContext,
  isEphemeralOwnerId,
  parentConflictResourceKeys,
  resolveEphemeralOwnerId,
  resolveTaskRunId,
  runWithTaskContext,
  type ExecutionLaneName,
  type ResourceGuardMode,
  type ResourceIdentityDescriptor,
} from "./resource-guard.js";

export type PendingAction = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  expectedHash: string | null;
  tokenHash: string;
  expiresAt: string;
  used: boolean;
};

export type ResourceLockRecord = {
  id: string;
  resource: string;
  canonicalPath?: string;
  physicalId?: string | null;
  ownerKind?: "task" | "ephemeral";
  mode: ResourceGuardMode;
  taskRunId: string;
  lane: ExecutionLaneName;
  expiresAt: string;
  createdAt: string;
  renewed?: boolean;
  upgraded?: boolean;
};

function isSqliteBusyError(error: unknown) {
  const detail = error as { errcode?: number; errstr?: string; message?: string };
  return (
    detail?.errcode === 5 ||
    detail?.errcode === 6 ||
    /database is (?:locked|busy)/i.test(String(detail?.errstr || detail?.message || error))
  );
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path = resolve(DATA_DIR, "workstation.sqlite")) {
    this.db = new DatabaseSync(path);
    // Avoid failing immediately when another MCP process/worker briefly owns the SQLite writer lock.
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL,
        status TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        expected_hash TEXT, token_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_clients(
        client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes(
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        challenge TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens(
        token_hash TEXT PRIMARY KEY, type TEXT NOT NULL, client_id TEXT NOT NULL,
        expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_lane_reservations(
        id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, step_id TEXT, lane TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_lane_reservations_lane ON execution_lane_reservations(lane,expires_at);
      CREATE INDEX IF NOT EXISTS idx_execution_lane_reservations_task ON execution_lane_reservations(task_run_id,expires_at);
      CREATE TABLE IF NOT EXISTS execution_resource_locks(
        id TEXT PRIMARY KEY, resource TEXT NOT NULL, mode TEXT NOT NULL,
        task_run_id TEXT NOT NULL, lane TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
        canonical_path TEXT, physical_id TEXT, owner_kind TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_execution_resource_locks_resource ON execution_resource_locks(resource,expires_at);
      CREATE INDEX IF NOT EXISTS idx_execution_resource_locks_task ON execution_resource_locks(task_run_id,expires_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS file_index USING fts5(path, kind, content, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS indexed_files(path TEXT PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, indexed_at TEXT NOT NULL);
    `);
    this.ensureLockTableColumns();
  }

  private ensureLockTableColumns(): void {
    try {
      const cols = this.db.prepare("PRAGMA table_info(execution_resource_locks)").all() as Array<{ name: string }>;
      const colNames = new Set(cols.map((c) => c.name));
      if (!colNames.has("canonical_path")) {
        this.db.exec("ALTER TABLE execution_resource_locks ADD COLUMN canonical_path TEXT;");
      }
      if (!colNames.has("physical_id")) {
        this.db.exec("ALTER TABLE execution_resource_locks ADD COLUMN physical_id TEXT;");
      }
      if (!colNames.has("owner_kind")) {
        this.db.exec("ALTER TABLE execution_resource_locks ADD COLUMN owner_kind TEXT;");
      }
    } catch {
      // Ignore if columns already exist or table is locked transiently.
    }
  }

  withTaskContext<T>(taskRunId: string | undefined, fn: () => T, lane?: ExecutionLaneName): T {
    return runWithTaskContext({ taskRunId, lane }, fn);
  }

  withEphemeralContext<T>(ephemeralOwnerId: string, fn: () => T, lane?: ExecutionLaneName): T {
    return runWithTaskContext({ ephemeralOwnerId, lane }, fn);
  }

  private hasTable(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(tableName);
    return Boolean(row);
  }

  reconcileExpiredAndInactiveTaskResources(): { orphanLocksReleased: number; orphanReservationsReleased: number } {
    let orphanLocksReleased = 0;
    let orphanReservationsReleased = 0;
    try {
      const now = nowIso();
      const expLocks = this.db.prepare("DELETE FROM execution_resource_locks WHERE expires_at<=?").run(now);
      const expRes = this.db.prepare("DELETE FROM execution_lane_reservations WHERE expires_at<=?").run(now);
      orphanLocksReleased += Number(expLocks.changes ?? 0);
      orphanReservationsReleased += Number(expRes.changes ?? 0);

      if (this.hasTable("pending")) {
        const stalePendingLocks = this.db.prepare(`
          DELETE FROM execution_resource_locks
          WHERE task_run_id LIKE 'ephemeral:pending:%'
            AND task_run_id NOT IN (
              SELECT 'ephemeral:pending:' || id FROM pending WHERE used = 0 AND expires_at > ?
            )
        `).run(now);
        orphanLocksReleased += Number(stalePendingLocks.changes ?? 0);
      }

      if (!this.hasTable("agent_runs")) {
        return { orphanLocksReleased, orphanReservationsReleased };
      }
      const expiredRuns = this.db
        .prepare("SELECT id FROM agent_runs WHERE state IN ('running','waiting_confirmation') AND deadline_at<=?")
        .all(now) as Array<{ id: string }>;
      for (const expired of expiredRuns) {
        this.db
          .prepare("UPDATE agent_runs SET state='expired', updated_at=?, active_step_id=NULL WHERE id=?")
          .run(now, String(expired.id));
        if (this.hasTable("task_authorizations")) {
          this.db
            .prepare("UPDATE task_authorizations SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL")
            .run(now, String(expired.id));
        }
        if (this.hasTable("task_capability_leases")) {
          this.db
            .prepare("UPDATE task_capability_leases SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL")
            .run(now, String(expired.id));
        }
      }
      const lockResult = this.db.prepare(`
        DELETE FROM execution_resource_locks
        WHERE task_run_id NOT LIKE 'ephemeral:%'
          AND task_run_id NOT IN (
            SELECT id FROM agent_runs WHERE state IN ('running','waiting_confirmation')
          )
      `).run();
      const reservationResult = this.db.prepare(`
        DELETE FROM execution_lane_reservations
        WHERE task_run_id NOT LIKE 'ephemeral:%'
          AND task_run_id NOT IN (
            SELECT id FROM agent_runs WHERE state IN ('running','waiting_confirmation')
          )
      `).run();
      orphanLocksReleased += Number(lockResult.changes ?? 0);
      orphanReservationsReleased += Number(reservationResult.changes ?? 0);
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
    }
    return { orphanLocksReleased, orphanReservationsReleased };
  }

  releaseEphemeralOwnerResources(ephemeralOwnerIdInput: string, reason = "ephemeral_completed"): { locksReleased: number; reservationsReleased: number } {
    const ephemeralOwnerId = String(ephemeralOwnerIdInput ?? "").trim();
    if (!isEphemeralOwnerId(ephemeralOwnerId)) {
      throw new Error("releaseEphemeralOwnerResources requires a valid ephemeral owner ID.");
    }
    let locksReleased = 0;
    let reservationsReleased = 0;
    try {
      const lockRes = this.db.prepare("DELETE FROM execution_resource_locks WHERE task_run_id=?").run(ephemeralOwnerId);
      const resRes = this.db.prepare("DELETE FROM execution_lane_reservations WHERE task_run_id=?").run(ephemeralOwnerId);
      locksReleased = Number(lockRes.changes ?? 0);
      reservationsReleased = Number(resRes.changes ?? 0);
      if (locksReleased > 0 || reservationsReleased > 0) {
        this.audit("execution_hygiene", "ephemeral_resources_released", {
          ephemeralOwnerId,
          reason,
          locksReleased,
          reservationsReleased,
        });
      }
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
    }
    return { locksReleased, reservationsReleased };
  }

  purgeAllEphemeralResources(reason = "runtime_hygiene"): { locksReleased: number; reservationsReleased: number } {
    let locksReleased = 0;
    let reservationsReleased = 0;
    try {
      const lockRes = this.db.prepare("DELETE FROM execution_resource_locks WHERE task_run_id LIKE 'ephemeral:%'").run();
      const resRes = this.db.prepare("DELETE FROM execution_lane_reservations WHERE task_run_id LIKE 'ephemeral:%'").run();
      locksReleased = Number(lockRes.changes ?? 0);
      reservationsReleased = Number(resRes.changes ?? 0);
      if (locksReleased > 0 || reservationsReleased > 0) {
        this.audit("execution_hygiene", "ephemeral_resources_purged", {
          reason,
          locksReleased,
          reservationsReleased,
        });
      }
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
    }
    return { locksReleased, reservationsReleased };
  }

  requireExistingTaskRun(taskRunIdInput: string): { id: string; state: string; deadlineAt: string } {
    const taskRunId = String(taskRunIdInput ?? "").trim();
    if (!taskRunId || taskRunId.length > 256) {
      throw new Error("taskRunId is required and must not exceed 256 characters.");
    }
    if (isEphemeralOwnerId(taskRunId)) {
      throw new Error(`Task run '${taskRunId}' does not exist; ephemeral owner IDs cannot be used as durable taskRunIds.`);
    }
    this.reconcileExpiredAndInactiveTaskResources();
    if (!this.hasTable("agent_runs")) {
      throw new Error(`Task run '${taskRunId}' does not exist; no durable tasks are registered.`);
    }
    const row = this.db
      .prepare("SELECT id, state, deadline_at FROM agent_runs WHERE id=?")
      .get(taskRunId) as { id?: string; state?: string; deadline_at?: string } | undefined;
    if (!row) {
      throw new Error(`Task run '${taskRunId}' does not exist.`);
    }
    return {
      id: String(row.id),
      state: String(row.state),
      deadlineAt: String(row.deadline_at),
    };
  }

  requireActiveTaskRun(taskRunIdInput: string): { id: string; state: string; deadlineAt: string } {
    const task = this.requireExistingTaskRun(taskRunIdInput);
    if (!ACTIVE_LOCK_TASK_STATES.has(task.state)) {
      throw new Error(
        `Task run '${task.id}' is in state '${task.state}'; only active tasks (${[...ACTIVE_LOCK_TASK_STATES].join(", ")}) may acquire or renew execution resources.`,
      );
    }
    if (Date.parse(task.deadlineAt) <= Date.now()) {
      this.reconcileExpiredAndInactiveTaskResources();
      throw new Error(`Task run '${task.id}' has expired and cannot acquire or renew execution resources.`);
    }
    return task;
  }

  guardResources(
    resources: readonly string[],
    options?: {
      mode?: ResourceGuardMode;
      taskRunId?: string;
      ephemeralOwnerId?: string;
      payload?: Record<string, unknown> | null;
      lane?: ExecutionLaneName;
      ttlSeconds?: number;
      operation?: string;
    },
  ): {
    guarded: boolean;
    canonicalOrder: string[];
    ownerId: string;
    ownerKind: "task" | "ephemeral";
    ephemeralOwnerId?: string;
    locks: ResourceLockRecord[];
  } {
    const descriptorMap = new Map<string, ResourceIdentityDescriptor>();
    for (const item of resources) {
      const desc = describeResourceIdentity(item);
      if (!descriptorMap.has(desc.key)) {
        descriptorMap.set(desc.key, desc);
      } else {
        const existingDesc = descriptorMap.get(desc.key)!;
        const mergedAliases = new Set([...existingDesc.aliasKeys, ...desc.aliasKeys]);
        existingDesc.aliasKeys = [...mergedAliases];
      }
    }
    const canonicalOrder = [...descriptorMap.keys()].sort();
    const effectiveTaskRunId = resolveTaskRunId(options?.taskRunId, options?.payload);
    if (effectiveTaskRunId) {
      this.requireActiveTaskRun(effectiveTaskRunId);
    }
    const effectiveEphemeralOwnerId = effectiveTaskRunId
      ? undefined
      : (resolveEphemeralOwnerId(options?.ephemeralOwnerId, options?.payload) ?? createEphemeralOwnerId("op"));
    const ownerId = effectiveTaskRunId ?? effectiveEphemeralOwnerId!;
    const ownerKind: "task" | "ephemeral" = effectiveTaskRunId ? "task" : "ephemeral";

    if (canonicalOrder.length === 0) {
      return {
        guarded: true,
        canonicalOrder: [],
        ownerId,
        ownerKind,
        ephemeralOwnerId: effectiveEphemeralOwnerId,
        locks: [],
      };
    }
    this.reconcileExpiredAndInactiveTaskResources();

    const mode: ResourceGuardMode = options?.mode ?? "write";
    const lane: ExecutionLaneName = options?.lane ?? getCurrentTaskContext()?.lane ?? "background";
    const defaultTtl = ownerKind === "task" ? 600 : 300;
    const ttlSeconds = Math.max(2, Math.min(Math.floor(options?.ttlSeconds ?? defaultTtl), 24 * 60 * 60));

    const now = nowIso();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const modeRank: Record<ResourceGuardMode, number> = { read: 1, write: 2, exclusive: 3 };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const resourceKey of canonicalOrder) {
        const desc = descriptorMap.get(resourceKey)!;
        const keysToCheck = [
          ...new Set([
            desc.key,
            ...desc.aliasKeys,
            ...parentConflictResourceKeys(desc.canonicalPath),
          ]),
        ];
        for (const checkKey of keysToCheck) {
          const existing = this.db
            .prepare("SELECT * FROM execution_resource_locks WHERE (resource=? OR canonical_path=?) AND expires_at>? ORDER BY created_at")
            .all(checkKey, checkKey, now) as Record<string, unknown>[];
          for (const row of existing) {
            const holderTaskId = String(row.task_run_id);
            if (holderTaskId === ownerId) {
              continue;
            }
            const otherMode = String(row.mode) as ResourceGuardMode;
            if (mode !== "read" || otherMode !== "read") {
              const diagLabel =
                desc.canonicalPath && desc.canonicalPath !== desc.key
                  ? `${desc.key} (${desc.canonicalPath})`
                  : desc.key;
              throw new Error(
                `Resource is busy: ${diagLabel} is locked by task ${holderTaskId} in ${String(row.lane)} mode (${otherMode}).`,
              );
            }
          }
        }
      }

      const acquiredLocks: ResourceLockRecord[] = [];
      for (const resourceKey of canonicalOrder) {
        const desc = descriptorMap.get(resourceKey)!;
        const existing = this.db
          .prepare("SELECT * FROM execution_resource_locks WHERE (resource=? OR canonical_path=?) AND expires_at>? ORDER BY created_at")
          .all(desc.key, desc.canonicalPath, now) as Record<string, unknown>[];
        const sameHolderRow = existing.find((row) => String(row.task_run_id) === ownerId);
        if (sameHolderRow) {
          const lockId = String(sameHolderRow.id);
          const prevMode = String(sameHolderRow.mode) as ResourceGuardMode;
          const effectiveMode: ResourceGuardMode = modeRank[mode] > modeRank[prevMode] ? mode : prevMode;
          const upgraded = effectiveMode !== prevMode;
          this.db
            .prepare("UPDATE execution_resource_locks SET resource=?, mode=?, lane=?, expires_at=?, canonical_path=?, physical_id=?, owner_kind=? WHERE id=?")
            .run(desc.key, effectiveMode, lane, expiresAt, desc.canonicalPath, desc.physicalId, ownerKind, lockId);
          this.audit("execution_lock", upgraded ? "upgraded" : "renewed", {
            lockId,
            resource: desc.key,
            canonicalPath: desc.canonicalPath,
            physicalId: desc.physicalId,
            ownerKind,
            mode: effectiveMode,
            previousMode: prevMode,
            taskRunId: ownerId,
            lane,
            expiresAt,
            operation: options?.operation ?? null,
          });
          acquiredLocks.push({
            id: lockId,
            resource: desc.key,
            canonicalPath: desc.canonicalPath,
            physicalId: desc.physicalId,
            ownerKind,
            mode: effectiveMode,
            taskRunId: ownerId,
            lane,
            expiresAt,
            createdAt: String(sameHolderRow.created_at),
            renewed: true,
            upgraded,
          });
        } else {
          const lockId = `lock-${randomBytes(12).toString("hex")}`;
          const createdAt = nowIso();
          this.db
            .prepare(
              "INSERT INTO execution_resource_locks(id,resource,mode,task_run_id,lane,expires_at,created_at,canonical_path,physical_id,owner_kind) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(lockId, desc.key, mode, ownerId, lane, expiresAt, createdAt, desc.canonicalPath, desc.physicalId, ownerKind);
          this.audit("execution_lock", "acquired", {
            lockId,
            resource: desc.key,
            canonicalPath: desc.canonicalPath,
            physicalId: desc.physicalId,
            ownerKind,
            mode,
            taskRunId: ownerId,
            lane,
            expiresAt,
            operation: options?.operation ?? null,
          });
          acquiredLocks.push({
            id: lockId,
            resource: desc.key,
            canonicalPath: desc.canonicalPath,
            physicalId: desc.physicalId,
            ownerKind,
            mode,
            taskRunId: ownerId,
            lane,
            expiresAt,
            createdAt,
          });
        }
      }

      this.db.exec("COMMIT");
      return {
        guarded: true,
        canonicalOrder,
        ownerId,
        ownerKind,
        ephemeralOwnerId: effectiveEphemeralOwnerId,
        locks: acquiredLocks,
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback error if transaction already closed.
      }
      throw error;
    }
  }

  audit(action: string, status: string, detail: unknown): void {
    this.db.prepare("INSERT INTO audit(at,action,status,detail) VALUES(?,?,?,?)")
      .run(nowIso(), action, status, JSON.stringify(detail));
  }

  recentAudit(limit = 100): unknown[] {
    return this.db.prepare("SELECT id,at,action,status,detail FROM audit ORDER BY id DESC LIMIT ?").all(limit);
  }

  allocatePendingId(): string {
    return `action-${randomToken(12)}`;
  }

  createPending(kind: string, payload: Record<string, unknown>, expectedHash: string | null, ttlSeconds = 300, preallocatedId?: string) {
    const id = preallocatedId ?? this.allocatePendingId();
    const confirmationToken = randomToken(18);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare("INSERT INTO pending(id,kind,payload,expected_hash,token_hash,expires_at,used,created_at) VALUES(?,?,?,?,?,?,0,?)")
      .run(id, kind, JSON.stringify(payload), expectedHash, sha256(confirmationToken), expiresAt, nowIso());
    return { id, confirmationToken, expiresAt };
  }

  getPending(id: string, confirmationToken?: string): PendingAction {
    const row = this.db.prepare("SELECT * FROM pending WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Unknown pending action.");
    if (Number(row.used) === 1) throw new Error("Confirmation token was already used.");
    if (Date.parse(String(row.expires_at)) < Date.now()) {
      this.reconcileExpiredAndInactiveTaskResources();
      throw new Error("Confirmation token expired.");
    }
    if (confirmationToken !== undefined && sha256(confirmationToken) !== String(row.token_hash)) {
      throw new Error("Invalid confirmation token.");
    }
    return {
      id,
      kind: String(row.kind),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      expectedHash: row.expected_hash == null ? null : String(row.expected_hash),
      tokenHash: String(row.token_hash),
      expiresAt: String(row.expires_at),
      used: false,
    };
  }

  consumePending(id: string, confirmationToken: string): PendingAction {
    const row = this.db.prepare("SELECT * FROM pending WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Unknown pending action.");
    if (Number(row.used) === 1) throw new Error("Confirmation token was already used.");
    if (Date.parse(String(row.expires_at)) < Date.now()) {
      this.reconcileExpiredAndInactiveTaskResources();
      throw new Error("Confirmation token expired.");
    }
    if (sha256(confirmationToken) !== String(row.token_hash)) throw new Error("Invalid confirmation token.");
    this.db.prepare("UPDATE pending SET used=1 WHERE id=?").run(id);
    return {
      id,
      kind: String(row.kind),
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      expectedHash: row.expected_hash == null ? null : String(row.expected_hash),
      tokenHash: String(row.token_hash),
      expiresAt: String(row.expires_at),
      used: true,
    };
  }

  private deleteIndexRows(path: string): void {
    // Equality on an FTS5 column scans the entire corpus. MATCH narrows by the
    // indexed path tokens; exact equality then disambiguates punctuation/case.
    const query = `path : "${path.replace(/"/g, '\"\"')}"`;
    const rows = this.db.prepare("SELECT rowid FROM file_index WHERE file_index MATCH ? AND path=?").all(query, path) as Array<{ rowid: number }>;
    const remove = this.db.prepare("DELETE FROM file_index WHERE rowid=?");
    for (const row of rows) remove.run(row.rowid);
  }

  indexReplace(path: string, kind: string, content: string, size: number, mtimeMs: number): void {
    this.deleteIndexRows(path);
    this.db.prepare("INSERT INTO file_index(path,kind,content) VALUES(?,?,?)").run(path, kind, content);
    this.db.prepare("INSERT INTO indexed_files(path,kind,size,mtime_ms,indexed_at) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,size=excluded.size,mtime_ms=excluded.mtime_ms,indexed_at=excluded.indexed_at")
      .run(path, kind, size, mtimeMs, nowIso());
  }

  indexDelete(path: string): boolean {
    const indexed = this.db.prepare("DELETE FROM indexed_files WHERE path=?").run(path);
    this.deleteIndexRows(path);
    return Number(indexed.changes ?? 0) > 0;
  }

  indexMetadata(path: string): { path: string; kind: string; size: number; mtimeMs: number; indexedAt: string } | null {
    const row = this.db.prepare("SELECT path,kind,size,mtime_ms,indexed_at FROM indexed_files WHERE path=?").get(path) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { path: String(row.path), kind: String(row.kind), size: Number(row.size), mtimeMs: Number(row.mtime_ms), indexedAt: String(row.indexed_at) };
  }

  search(query: string, limit: number): unknown[] {
    return this.db.prepare("SELECT path,kind,snippet(file_index,2,'[',']','...',24) AS excerpt,rank FROM file_index WHERE file_index MATCH ? ORDER BY rank LIMIT ?").all(query, limit);
  }

  stats(): Record<string, unknown> {
    const files = this.db.prepare("SELECT COUNT(*) AS count FROM indexed_files").get() as { count: number };
    const last = this.db.prepare("SELECT MAX(indexed_at) AS at FROM indexed_files").get() as { at: string | null };
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM pending WHERE used=0 AND expires_at>?").get(nowIso()) as { count: number };
    return { indexedFiles: Number(files.count), lastIndexedAt: last.at, pendingActions: Number(pending.count) };
  }
}
