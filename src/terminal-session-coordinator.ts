import { TerminalService } from "./terminal.js";
import { TerminalSessionManager, TerminalSessionView } from "./terminal-session.js";

export type SessionPreview = {
  session: TerminalSessionView;
  preview: ReturnType<TerminalService["preview"]>;
};

export type SessionExecutionResult = {
  session: TerminalSessionView;
  result: Record<string, unknown>;
};

export class TerminalSessionCoordinator {
  constructor(readonly sessions: TerminalSessionManager, readonly terminal: TerminalService) {}

  create(cwd: string, env: Record<string, string> = {}) {
    return this.sessions.create(cwd, env);
  }

  status(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  list() {
    return this.sessions.list();
  }

  close(sessionId: string) {
    return this.sessions.close(sessionId);
  }

  setCwd(sessionId: string, cwd: string) {
    return this.sessions.setCwd(sessionId, cwd);
  }

  setEnvironment(sessionId: string, env: Record<string, string>) {
    return this.sessions.setEnvironment(sessionId, env);
  }

  preview(sessionId: string, command: string, timeoutSeconds?: number, wordCleanup = true): SessionPreview {
    const session = this.sessions.get(sessionId);
    if (session.state !== "open" && session.state !== "failed") throw new Error(`Terminal session is ${session.state}; it cannot preview a new step.`);
    if (/\b(?:Set-Location|Push-Location|Pop-Location)\b/i.test(command) || /(?:^|[;\r\n])\s*(?:cd|chdir|sl|pushd|popd)\b/i.test(command)) throw new Error("Persistent terminal sessions require terminal_session set_cwd instead of shell directory-changing commands.");
    const preview = this.terminal.preview(command, session.cwd, timeoutSeconds, session.env, undefined, wordCleanup);
    return { session, preview };
  }

  async execute(sessionId: string, actionId: string, commandHash: string, confirmationToken: string, criticalConfirmation?: string): Promise<SessionExecutionResult> {
    const busy = this.sessions.beginStep(sessionId, commandHash);
    const active = busy.activeStep;
    if (!active) throw new Error("Terminal session failed to enter an active step.");
    try {
      const result = await this.terminal.execute(actionId, commandHash, confirmationToken, criticalConfirmation);
      const exitCode = typeof result.code === "number" ? Number(result.code) : null;
      const timedOut = Boolean(result.timedOut);
      const cancelled = false;
      const verified = exitCode === 0 && !timedOut && !result.error;
      const session = this.sessions.completeStep(sessionId, {
        sequence: active.sequence,
        commandHash,
        exitCode,
        timedOut,
        cancelled,
        verified,
        stdoutChars: typeof result.stdout === "string" ? result.stdout.length : 0,
        stderrChars: typeof result.stderr === "string" ? result.stderr.length : 0,
      });
      return { session, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        this.sessions.completeStep(sessionId, {
          sequence: active.sequence,
          commandHash,
          exitCode: -1,
          verified: false,
          stderrChars: message.length,
        });
      } catch { /* preserve original terminal error */ }
      throw error;
    }
  }

  beginConfirmedStep(sessionId: string, commandHash: string) {
    return this.sessions.beginStep(sessionId, commandHash);
  }

  completeStep(sessionId: string, input: {
    sequence: number;
    commandHash: string;
    exitCode: number | null;
    timedOut?: boolean;
    cancelled?: boolean;
    verified: boolean;
    nextCwd?: string;
    stdoutChars?: number;
    stderrChars?: number;
  }) {
    return this.sessions.completeStep(sessionId, input);
  }

  resetFailed(sessionId: string) {
    return this.sessions.resetFailed(sessionId);
  }

  emergencyStop() {
    return this.sessions.emergencyStop();
  }

  clearEmergencyStop() {
    this.sessions.clearEmergencyStop();
  }
}
