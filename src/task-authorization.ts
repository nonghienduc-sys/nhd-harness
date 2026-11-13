import { randomToken } from "./security.js";
import { Store } from "./db.js";

export type TaskAuthorizationRisk = "moderate" | "high";
export type TaskCapabilityAction =
  | "send" | "submit" | "save" | "publish" | "post" | "reply" | "comment"
  | "create" | "confirm" | "apply" | "register" | "book" | "reserve" | "login"
  | "delete" | "upload" | "download" | "restart" | "external_protocol";

const RANK: Record<TaskAuthorizationRisk | "critical", number> = { moderate: 1, high: 2, critical: 3 };
const CAPABILITY_ACTIONS = new Set<TaskCapabilityAction>([
  "send", "submit", "save", "publish", "post", "reply", "comment", "create", "confirm", "apply", "register", "book", "reserve", "login",
  "delete", "upload", "download", "restart", "external_protocol",
]);
export const HARD_DENY_CAPABILITIES = new Set(["credentials", "payment", "transfer", "purchase", "call", "script_protocol"]);

export function isHardDeniedCapability(action: string): boolean {
  return HARD_DENY_CAPABILITIES.has(String(action ?? "").trim().toLowerCase());
}

export type TaskAuthorizationView = {
  id: string;
  runId: string;
  maxRiskLevel: TaskAuthorizationRisk;
  expiresAt: string;
  createdAt: string;
  active: boolean;
};

export type TaskCapabilityLeaseView = {
  id: string;
  runId: string;
  appScope: string;
  actions: TaskCapabilityAction[];
  maxCount: number;
  usedCount: number;
  remainingCount: number;
  expiresAt: string;
  createdAt: string;
  active: boolean;
};

export type TaskCapabilityUse = TaskCapabilityLeaseView & {
  useId: string;
  action: TaskCapabilityAction;
  app: string;
};

function normalizeScope(value: string) {
  return String(value).normalize("NFKC").toLocaleLowerCase("vi-VN").replace(/\s+/g, " ").trim();
}

function extractHostname(value: string): string | null {
  const normalized = normalizeScope(value);
  if (!normalized) return null;
  if (normalized.startsWith("domain:")) {
    const host = normalized.slice("domain:".length).trim().replace(/^www\./, "");
    return host && host !== "*" && host !== "all" ? host : null;
  }
  if (/^https?:\/\//i.test(normalized)) {
    try {
      return new URL(normalized).hostname.toLowerCase().replace(/^www\./, "") || null;
    } catch {
      return null;
    }
  }
  return null;
}

function scopeMatches(leaseScope: string, requestedApp: string) {
  const lease = normalizeScope(leaseScope);
  const app = normalizeScope(requestedApp);
  if (!lease || !app || lease === "*" || lease === "all") return false;
  if (lease.startsWith("window:") || app.startsWith("window:")) return lease === app;
  if (lease.startsWith("domain:")) {
    const targetDomain = extractHostname(lease);
    if (!targetDomain) return false;
    const appHost = extractHostname(app);
    if (appHost) return appHost === targetDomain || appHost.endsWith(`.${targetDomain}`);
    return app === targetDomain || app.includes(targetDomain);
  }
  return app === lease || app.includes(lease) || lease.includes(app);
}

export class TaskAuthorizationService {
  constructor(readonly store: Store) { this.initSchema(); }

  authorize(runId: string, maxRiskLevel: TaskAuthorizationRisk = "high", expiresAt?: string): TaskAuthorizationView {
    const run = this.runRow(runId);
    if (["completed", "cancelled", "expired", "failed"].includes(String(run.state))) throw new Error(`Task run is ${String(run.state)} and cannot receive a task authorization.`);
    const now = Date.now();
    const requestedExpiry = expiresAt ? Date.parse(expiresAt) : now + 2 * 60 * 60_000;
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now) throw new Error("Task authorization expiry is invalid or already expired.");
    const deadline = Date.parse(String(run.deadline_at ?? ""));
    const boundedExpiry = Number.isFinite(deadline) ? Math.min(requestedExpiry, deadline) : requestedExpiry;
    const id = `grant-${randomToken(12)}`;
    const createdAt = new Date(now).toISOString();
    const finalExpiry = new Date(boundedExpiry).toISOString();
    this.store.db.prepare("UPDATE task_authorizations SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL AND expires_at>? ").run(createdAt, runId, createdAt);
    this.store.db.prepare("INSERT INTO task_authorizations(id,run_id,max_risk_level,expires_at,created_at,revoked_at) VALUES(?,?,?,?,?,NULL)").run(id, runId, maxRiskLevel, finalExpiry, createdAt);
    this.store.audit("task_authorization", "granted", { runId, authorizationId: id, maxRiskLevel, expiresAt: finalExpiry });
    return { id, runId, maxRiskLevel, expiresAt: finalExpiry, createdAt, active: true };
  }

  grantCapability(runId: string, input: { appScope: string; actions: string[]; maxCount?: number; expiresAt?: string }): TaskCapabilityLeaseView {
    const run = this.runRow(runId);
    if (["completed", "cancelled", "expired", "failed"].includes(String(run.state))) throw new Error(`Task run is ${String(run.state)} and cannot receive a capability lease.`);
    const appScope = String(input.appScope ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!appScope) throw new Error("app_scope is required for a capability lease.");
    if (appScope === "*" || appScope.toLowerCase() === "all" || /^domain:\s*(\*|all)$/i.test(appScope)) {
      throw new Error("Wildcard app scopes are not allowed; capability leases must name a specific app/window/domain scope.");
    }
    const requested = [...new Set((input.actions ?? []).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
    if (!requested.length || requested.length > 16) throw new Error("capability_actions must contain 1-16 explicit actions.");
    for (const action of requested) {
      if (HARD_DENY_CAPABILITIES.has(action)) throw new Error(`Capability '${action}' is platform-hard-denied and cannot be leased.`);
      if (!CAPABILITY_ACTIONS.has(action as TaskCapabilityAction)) throw new Error(`Unsupported capability action '${action}'.`);
    }
    const maxCount = Math.max(1, Math.min(Math.floor(input.maxCount ?? 1), 100));
    const now = Date.now();
    const requestedExpiry = input.expiresAt ? Date.parse(input.expiresAt) : now + 10 * 60_000;
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now) throw new Error("Capability lease expiry is invalid or already expired.");
    const deadline = Date.parse(String(run.deadline_at ?? ""));
    const boundedExpiry = Number.isFinite(deadline) ? Math.min(requestedExpiry, deadline) : requestedExpiry;
    const id = `lease-${randomToken(12)}`;
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(boundedExpiry).toISOString();
    const actions = requested as TaskCapabilityAction[];
    this.store.db.prepare("INSERT INTO task_capability_leases(id,run_id,app_scope,actions_json,max_count,used_count,expires_at,created_at,revoked_at) VALUES(?,?,?,?,?,0,?,?,NULL)").run(id, runId, appScope, JSON.stringify(actions), maxCount, expiresAt, createdAt);
    this.store.audit("task_capability_lease", "granted", { runId, leaseId: id, appScope, actions, maxCount, expiresAt });
    return { id, runId, appScope, actions, maxCount, usedCount: 0, remainingCount: maxCount, expiresAt, createdAt, active: true };
  }

  revoke(runId: string): { runId: string; revoked: boolean; capabilityLeasesRevoked: number } {
    const now = new Date().toISOString();
    const result = this.store.db.prepare("UPDATE task_authorizations SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL").run(now, runId);
    const capabilityResult = this.store.db.prepare("UPDATE task_capability_leases SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL").run(now, runId);
    const revoked = Number(result.changes ?? 0) > 0;
    const capabilityLeasesRevoked = Number(capabilityResult.changes ?? 0);
    this.store.audit("task_authorization", revoked || capabilityLeasesRevoked ? "revoked" : "revoke_noop", { runId, capabilityLeasesRevoked });
    return { runId, revoked, capabilityLeasesRevoked };
  }

  revokeCapability(runId: string, leaseId?: string): { runId: string; leaseId: string | null; revoked: number } {
    this.runRow(runId);
    const now = new Date().toISOString();
    const result = leaseId
      ? this.store.db.prepare("UPDATE task_capability_leases SET revoked_at=? WHERE run_id=? AND id=? AND revoked_at IS NULL").run(now, runId, leaseId)
      : this.store.db.prepare("UPDATE task_capability_leases SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL").run(now, runId);
    const revoked = Number(result.changes ?? 0);
    this.store.audit("task_capability_lease", revoked ? "revoked" : "revoke_noop", { runId, leaseId: leaseId ?? null, revoked });
    return { runId, leaseId: leaseId ?? null, revoked };
  }

  active(runId: string): TaskAuthorizationView | null {
    const row = this.store.db.prepare("SELECT id,run_id,max_risk_level,expires_at,created_at,revoked_at FROM task_authorizations WHERE run_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const expiresAt = String(row.expires_at);
    const active = Date.parse(expiresAt) > Date.now();
    if (!active) { this.store.db.prepare("UPDATE task_authorizations SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(new Date().toISOString(), String(row.id)); return null; }
    return { id: String(row.id), runId: String(row.run_id), maxRiskLevel: String(row.max_risk_level) as TaskAuthorizationRisk, expiresAt, createdAt: String(row.created_at), active: true };
  }

  activeCapabilities(runId: string): TaskCapabilityLeaseView[] {
    const now = new Date().toISOString();
    this.store.db.prepare("UPDATE task_capability_leases SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL AND (expires_at<=? OR used_count>=max_count)").run(now, runId, now);
    const rows = this.store.db.prepare("SELECT * FROM task_capability_leases WHERE run_id=? AND revoked_at IS NULL AND expires_at>? AND used_count<max_count ORDER BY created_at DESC").all(runId, now) as Record<string, unknown>[];
    return rows.map((row) => this.capabilityView(row));
  }

  hasCapabilityHistory(runId: string): boolean {
    const row = this.store.db.prepare("SELECT 1 FROM task_capability_leases WHERE run_id=? LIMIT 1").get(runId);
    return Boolean(row);
  }

  matchCapability(runId: string, app: string, action: string): TaskCapabilityLeaseView | null {
    const run = this.runRow(runId);
    if (String(run.state) !== "running") return null;
    const normalizedAction = String(action).toLowerCase() as TaskCapabilityAction;
    if (!CAPABILITY_ACTIONS.has(normalizedAction)) return null;
    return this.activeCapabilities(runId).find((lease) => lease.actions.includes(normalizedAction) && scopeMatches(lease.appScope, app)) ?? null;
  }

  allowsCapability(runId: string, app: string, action: string): boolean { return Boolean(this.matchCapability(runId, app, action)); }

  consumeCapability(runId: string, app: string, action: string): TaskCapabilityUse {
    const lease = this.matchCapability(runId, app, action);
    if (!lease) throw new Error(`No active capability lease covers '${action}' for app scope '${app}'.`);
    const now = new Date().toISOString();
    const result = this.store.db.prepare("UPDATE task_capability_leases SET used_count=used_count+1 WHERE id=? AND run_id=? AND revoked_at IS NULL AND expires_at>? AND used_count<max_count").run(lease.id, runId, now);
    if (Number(result.changes ?? 0) !== 1) throw new Error("Capability lease was concurrently consumed, revoked, or expired.");
    const row = this.store.db.prepare("SELECT * FROM task_capability_leases WHERE id=?").get(lease.id) as Record<string, unknown>;
    const updated = this.capabilityView(row);
    const useId = `use-${randomToken(12)}`;
    this.store.audit("task_capability_lease", "consumed", { runId, leaseId: lease.id, useId, app, action, remainingCount: updated.remainingCount });
    return { ...updated, useId, action: action as TaskCapabilityAction, app };
  }

  allows(runId: string, requiredLevel: "minimal" | "low" | "moderate" | "high" | "critical"): boolean {
    if (requiredLevel === "critical") return false;
    const grant = this.active(runId);
    if (!grant) return false;
    const requiredRank = requiredLevel === "high" ? 2 : 1;
    return RANK[grant.maxRiskLevel] >= requiredRank;
  }

  stats() {
    const now = new Date().toISOString();
    this.store.db.prepare("UPDATE task_authorizations SET revoked_at=? WHERE revoked_at IS NULL AND expires_at<=?").run(now, now);
    this.store.db.prepare("UPDATE task_capability_leases SET revoked_at=? WHERE revoked_at IS NULL AND (expires_at<=? OR used_count>=max_count)").run(now, now);
    const activeAuthRow = this.store.db.prepare("SELECT COUNT(*) AS c FROM task_authorizations WHERE revoked_at IS NULL AND expires_at>?").get(now) as { c?: number } | undefined;
    const activeLeaseRow = this.store.db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(max_count - used_count), 0) AS remaining FROM task_capability_leases WHERE revoked_at IS NULL AND expires_at>? AND used_count<max_count").get(now) as { c?: number; remaining?: number } | undefined;
    const totalUsedRow = this.store.db.prepare("SELECT COALESCE(SUM(used_count), 0) AS used, COUNT(*) AS total FROM task_capability_leases").get() as { used?: number; total?: number } | undefined;
    return {
      activeAuthorizations: Number(activeAuthRow?.c ?? 0),
      activeCapabilityLeases: Number(activeLeaseRow?.c ?? 0),
      remainingCapabilityUses: Number(activeLeaseRow?.remaining ?? 0),
      consumedCapabilityUses: Number(totalUsedRow?.used ?? 0),
      totalCapabilityLeasesIssued: Number(totalUsedRow?.total ?? 0),
      hardDenyCapabilities: [...HARD_DENY_CAPABILITIES],
    };
  }

  private runRow(runId: string) {
    const run = this.store.db.prepare("SELECT state,deadline_at FROM agent_runs WHERE id=?").get(runId) as { state?: string; deadline_at?: string } | undefined;
    if (!run) throw new Error("Task run was not found.");
    return run;
  }

  private capabilityView(row: Record<string, unknown>): TaskCapabilityLeaseView {
    let actions: TaskCapabilityAction[] = [];
    try { actions = JSON.parse(String(row.actions_json ?? "[]")) as TaskCapabilityAction[]; } catch {}
    const maxCount = Number(row.max_count ?? 1);
    const usedCount = Number(row.used_count ?? 0);
    const expiresAt = String(row.expires_at);
    return { id: String(row.id), runId: String(row.run_id), appScope: String(row.app_scope), actions, maxCount, usedCount, remainingCount: Math.max(0, maxCount - usedCount), expiresAt, createdAt: String(row.created_at), active: !row.revoked_at && Date.parse(expiresAt) > Date.now() && usedCount < maxCount };
  }

  private initSchema() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS task_authorizations(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, max_risk_level TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_authorizations_run ON task_authorizations(run_id,expires_at,revoked_at);
      CREATE TABLE IF NOT EXISTS task_capability_leases(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, app_scope TEXT NOT NULL, actions_json TEXT NOT NULL,
        max_count INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_capability_leases_run ON task_capability_leases(run_id,expires_at,revoked_at);
    `);
  }
}
