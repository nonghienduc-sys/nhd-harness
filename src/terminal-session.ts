import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type TerminalSessionState = "open" | "busy" | "failed" | "closed" | "expired";

export type TerminalSessionStep = {
  sequence: number;
  commandHash: string;
  cwdBefore: string;
  cwdAfter: string;
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  verified: boolean;
  stateChanged: boolean;
  stdoutChars: number;
  stderrChars: number;
};

export type TerminalSessionView = {
  id: string;
  state: TerminalSessionState;
  cwd: string;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  sequence: number;
  activeStep: { sequence: number; commandHash: string; cwdBefore: string; startedAt: string } | null;
  history: TerminalSessionStep[];
};

type InternalSession = TerminalSessionView & {
  expiresAtMs: number;
};

export type TerminalSessionManagerOptions = {
  roots: string[];
  maxSessions?: number;
  ttlMs?: number;
  maxHistory?: number;
  allowedEnvironment?: string[];
  requireExistingCwd?: boolean;
  now?: () => number;
};

export class TerminalSessionError extends Error {
  constructor(readonly code: "INVALID_CWD" | "SESSION_LIMIT" | "NOT_FOUND" | "NOT_OPEN" | "BUSY" | "STEP_MISMATCH" | "ENV_BLOCKED" | "EMERGENCY_STOP", message: string) {
    super(message);
    this.name = "TerminalSessionError";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly roots: string[];
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly maxHistory: number;
  private readonly allowedEnvironment: Set<string>;
  private readonly requireExistingCwd: boolean;
  private readonly now: () => number;
  private emergencyStopped = false;

  constructor(options: TerminalSessionManagerOptions) {
    if (!options.roots?.length) throw new Error("At least one terminal session root is required.");
    this.roots = options.roots.map((root) => resolve(root));
    this.maxSessions = Math.max(1, Math.min(options.maxSessions ?? 4, 32));
    this.ttlMs = Math.max(30_000, Math.min(options.ttlMs ?? 30 * 60_000, 24 * 60 * 60_000));
    this.maxHistory = Math.max(1, Math.min(options.maxHistory ?? 50, 500));
    this.allowedEnvironment = new Set((options.allowedEnvironment ?? ["NODE_ENV", "PYTHONUTF8", "PYTHONIOENCODING"]).map((name) => name.toUpperCase()));
    this.requireExistingCwd = options.requireExistingCwd === true;
    this.now = options.now ?? Date.now;
  }

  create(cwdInput: string, env: Record<string, string> = {}): TerminalSessionView {
    this.assertNotStopped();
    this.sweep();
    const active = [...this.sessions.values()].filter((session) => session.state === "open" || session.state === "busy" || session.state === "failed");
    if (active.length >= this.maxSessions) throw new TerminalSessionError("SESSION_LIMIT", `Maximum active terminal sessions reached (${this.maxSessions}).`);
    const cwd = this.validateCwd(cwdInput);
    const safeEnv = this.validateEnv(env);
    const now = this.now();
    const id = `term-${randomBytes(16).toString("hex")}`;
    const session: InternalSession = {
      id,
      state: "open",
      cwd,
      env: safeEnv,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      expiresAtMs: now + this.ttlMs,
      sequence: 0,
      activeStep: null,
      history: [],
    };
    this.sessions.set(id, session);
    return this.view(session);
  }

  get(id: string): TerminalSessionView {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) throw new TerminalSessionError("NOT_FOUND", "Terminal session was not found.");
    return this.view(session);
  }

  list(): TerminalSessionView[] {
    this.sweep();
    return [...this.sessions.values()].map((session) => this.view(session));
  }

  beginStep(id: string, commandHash: string): TerminalSessionView {
    this.assertNotStopped();
    this.sweep();
    const session = this.requireSession(id);
    if (session.state === "busy") throw new TerminalSessionError("BUSY", "Terminal session already has an active step.");
    if (session.state !== "open" && session.state !== "failed") throw new TerminalSessionError("NOT_OPEN", `Terminal session is ${session.state}.`);
    if (!/^[a-f0-9]{64}$/i.test(commandHash)) throw new Error("commandHash must be a SHA-256 hex string.");
    const now = this.now();
    const sequence = session.sequence + 1;
    session.sequence = sequence;
    session.state = "busy";
    session.activeStep = { sequence, commandHash: commandHash.toLowerCase(), cwdBefore: session.cwd, startedAt: new Date(now).toISOString() };
    this.touch(session, now);
    return this.view(session);
  }

  completeStep(id: string, input: {
    sequence: number;
    commandHash: string;
    exitCode: number | null;
    timedOut?: boolean;
    cancelled?: boolean;
    verified: boolean;
    nextCwd?: string;
    stdoutChars?: number;
    stderrChars?: number;
  }): TerminalSessionView {
    this.sweep();
    const session = this.requireSession(id);
    if (session.state !== "busy" || !session.activeStep) throw new TerminalSessionError("NOT_OPEN", "Terminal session has no active step.");
    if (session.activeStep.sequence !== input.sequence || session.activeStep.commandHash !== input.commandHash.toLowerCase()) {
      throw new TerminalSessionError("STEP_MISMATCH", "Terminal step identity does not match the active previewed step.");
    }
    const now = this.now();
    let cwdAfter = session.cwd;
    let stateChanged = false;
    if (input.verified && input.exitCode === 0 && !input.timedOut && !input.cancelled && input.nextCwd) {
      const validated = this.validateCwd(input.nextCwd);
      if (validated !== session.cwd) {
        cwdAfter = validated;
        session.cwd = validated;
        stateChanged = true;
      }
    }
    const step: TerminalSessionStep = {
      sequence: session.activeStep.sequence,
      commandHash: session.activeStep.commandHash,
      cwdBefore: session.activeStep.cwdBefore,
      cwdAfter,
      startedAt: session.activeStep.startedAt,
      completedAt: new Date(now).toISOString(),
      exitCode: input.exitCode,
      timedOut: Boolean(input.timedOut),
      cancelled: Boolean(input.cancelled),
      verified: Boolean(input.verified),
      stateChanged,
      stdoutChars: Math.max(0, input.stdoutChars ?? 0),
      stderrChars: Math.max(0, input.stderrChars ?? 0),
    };
    session.history.push(step);
    if (session.history.length > this.maxHistory) session.history.splice(0, session.history.length - this.maxHistory);
    session.activeStep = null;
    session.state = input.verified && input.exitCode === 0 && !input.timedOut && !input.cancelled ? "open" : "failed";
    this.touch(session, now);
    return this.view(session);
  }

  resetFailed(id: string): TerminalSessionView {
    this.assertNotStopped();
    this.sweep();
    const session = this.requireSession(id);
    if (session.state !== "failed") throw new TerminalSessionError("NOT_OPEN", `Terminal session is ${session.state}, not failed.`);
    session.state = "open";
    this.touch(session, this.now());
    return this.view(session);
  }

  setCwd(id: string, cwdInput: string): TerminalSessionView {
    this.assertNotStopped();
    this.sweep();
    const session = this.requireSession(id);
    if (session.state === "busy") throw new TerminalSessionError("BUSY", "Cannot change session cwd while a step is active.");
    if (session.state !== "open" && session.state !== "failed") throw new TerminalSessionError("NOT_OPEN", `Terminal session is ${session.state}.`);
    session.cwd = this.validateCwd(cwdInput);
    this.touch(session, this.now());
    return this.view(session);
  }

  setEnvironment(id: string, env: Record<string, string>): TerminalSessionView {
    this.assertNotStopped();
    this.sweep();
    const session = this.requireSession(id);
    if (session.state === "busy") throw new TerminalSessionError("BUSY", "Cannot change session environment while a step is active.");
    if (session.state !== "open" && session.state !== "failed") throw new TerminalSessionError("NOT_OPEN", `Terminal session is ${session.state}.`);
    session.env = { ...session.env, ...this.validateEnv(env) };
    this.touch(session, this.now());
    return this.view(session);
  }

  close(id: string): TerminalSessionView {
    const session = this.requireSession(id);
    if (session.state === "busy") throw new TerminalSessionError("BUSY", "Cannot close a terminal session while a step is active.");
    session.state = "closed";
    session.activeStep = null;
    this.touch(session, this.now(), false);
    return this.view(session);
  }

  sweep(): number {
    const now = this.now();
    let expired = 0;
    for (const session of this.sessions.values()) {
      if ((session.state === "open" || session.state === "failed") && session.expiresAtMs <= now) {
        session.state = "expired";
        session.activeStep = null;
        session.updatedAt = new Date(now).toISOString();
        expired += 1;
      }
    }
    return expired;
  }

  emergencyStop(): number {
    this.emergencyStopped = true;
    const now = this.now();
    let invalidated = 0;
    for (const session of this.sessions.values()) {
      if (session.state === "open" || session.state === "busy" || session.state === "failed") {
        session.state = "closed";
        session.activeStep = null;
        session.updatedAt = new Date(now).toISOString();
        invalidated += 1;
      }
    }
    return invalidated;
  }

  clearEmergencyStop() {
    this.emergencyStopped = false;
  }

  private requireSession(id: string): InternalSession {
    const session = this.sessions.get(id);
    if (!session) throw new TerminalSessionError("NOT_FOUND", "Terminal session was not found.");
    return session;
  }

  private validateCwd(input: string): string {
    if (!input || !isAbsolute(input)) throw new TerminalSessionError("INVALID_CWD", "Terminal session cwd must be an absolute path.");
    const cwd = resolve(input);
    const allowed = this.roots.some((root) => {
      const rel = relative(root, cwd);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
    if (!allowed) throw new TerminalSessionError("INVALID_CWD", "Terminal session cwd is outside configured roots.");
    if (this.requireExistingCwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) throw new TerminalSessionError("INVALID_CWD", "Terminal session cwd must be an existing directory.");
    return cwd;
  }

  private validateEnv(env: Record<string, string>): Record<string, string> {
    const safe: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(env)) {
      const name = rawName.toUpperCase();
      if (!this.allowedEnvironment.has(name)) throw new TerminalSessionError("ENV_BLOCKED", `Environment variable '${rawName}' is not allowed in persistent terminal sessions.`);
      if (rawValue.length > 2000) throw new TerminalSessionError("ENV_BLOCKED", `Environment variable '${rawName}' is too large.`);
      if (/\r|\n|\0/.test(rawValue)) throw new TerminalSessionError("ENV_BLOCKED", `Environment variable '${rawName}' contains prohibited control characters.`);
      safe[name] = rawValue;
    }
    return safe;
  }

  private touch(session: InternalSession, now: number, extendExpiry = true) {
    session.updatedAt = new Date(now).toISOString();
    if (extendExpiry && (session.state === "open" || session.state === "busy" || session.state === "failed")) {
      session.expiresAtMs = now + this.ttlMs;
      session.expiresAt = new Date(session.expiresAtMs).toISOString();
    }
  }

  private assertNotStopped() {
    if (this.emergencyStopped) throw new TerminalSessionError("EMERGENCY_STOP", "Terminal sessions are disabled by Emergency Stop.");
  }

  private view(session: InternalSession): TerminalSessionView {
    const { expiresAtMs: _expiresAtMs, ...publicView } = session;
    return clone(publicView);
  }
}
