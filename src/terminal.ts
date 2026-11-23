import { spawn } from "node:child_process";
import { isAbsolute as isAbsolutePath, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { FileService } from "./files.js";
import { nowIso, redact, sha256 } from "./security.js";
import { assessTerminalRisk, RiskAssessment } from "./risk-policy.js";
import { TaskAuthorizationService } from "./task-authorization.js";
import { BackgroundTurboService, isTurboSafePowerShell } from "./background-turbo.js";
import { cleanWordProcesses, nativeWordProcessProvider, wordCleanupEnabled, type WordProcessProvider, type WordProcessInfo } from "./word-cleanup.js";
import { receiptStaleWarnings } from "./receipt-write.js";

export type Risk = "normal" | "elevated" | "critical";

export type TerminalServiceOptions = {
  maxConcurrentRuns?: number;
  drainGraceMs?: number;
  spawnProcess?: typeof spawn;
  isProcessAlive?: (pid: number) => boolean;
  wordProcessProvider?: WordProcessProvider;
};

// v0.24.47: lệnh chỉ đọc/đếm tệp → gợi ý code_run (không cần preview/token, 1 lượt).
const CODE_RUN_ADVICE = "Read-only file inspection: prefer one code_run (tools.fs_list/fs_read/fs_search), no preview/token needed.";
const READ_ONLY_CMDLETS = new Set(["get-childitem","gci","ls","dir","get-content","gc","cat","type","select-string","sls","measure-object","measure","sort-object","sort","select-object","select","where-object","where","?","foreach-object","foreach","%","format-table","ft","format-list","fl","group-object","group","test-path","get-item","gi","resolve-path","split-path","join-path","out-string","get-filehash","convertto-json","write-output","echo"]);
export function isReadOnlyFileInspection(command: string): boolean {
  let text = command;
  for (let i = 0; i < 4; i += 1) text = text.replace(/\{[^{}]*\}/g, (m) => m.replace(/[{}|;\r\n]/g, " "));
  if (/[{}]|(^|[^-])>|(^|\s)[&.]\s|\b(set|add|new|remove|move|copy|rename|clear|out)-(?!string\b)[a-z]+|\binvoke-|\bstart-|\b(rm|del|mv|cp|ni|iex)\b|\[(io\.)?file\]::(write|append|delete|move|copy)/i.test(text)) return false;
  const segments = text.split(/[|;\r\n]+/).map((x) => x.trim()).filter(Boolean);
  if (!segments.length) return false;
  let sawRead = false;
  for (const segment of segments) {
    const head = segment.replace(/^\$[\w:]+\s*=\s*/, "").replace(/^[(@]+/, "").split(/\s+/)[0]?.toLowerCase() ?? "";
    if (/^\$[\w:]+$/.test(head)) continue;
    if (!READ_ONLY_CMDLETS.has(head)) return false;
    if (/^(get-childitem|gci|ls|dir|get-content|gc|cat|type|select-string|sls)$/.test(head)) sawRead = true;
  }
  return sawRead;
}

export class TerminalService {
  private readonly running = new Map<string, { pid: number; startedAt: string }>();
  private readonly maxConcurrentRuns: number;
  private readonly drainGraceMs: number;
  private readonly spawnProcess: typeof spawn;
  private readonly processAliveProbe: (pid: number) => boolean;
  private readonly wordProcessProvider: WordProcessProvider;
  private readonly wordMonitoringEnabled: boolean;
  private readonly taskAuthorizations?: TaskAuthorizationService;
  private backgroundTurbo?: BackgroundTurboService;

  constructor(readonly config: AppConfig, readonly store: Store, readonly files: FileService, options: TerminalServiceOptions = {}, taskAuthorizations?: TaskAuthorizationService) {
    this.maxConcurrentRuns = Math.min(Math.max(Math.trunc(options.maxConcurrentRuns ?? 3), 1), 16);
    this.drainGraceMs = Math.min(Math.max(Math.trunc(options.drainGraceMs ?? 100), 0), 5000);
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.processAliveProbe = options.isProcessAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    this.taskAuthorizations = taskAuthorizations;
    this.wordProcessProvider = options.wordProcessProvider ?? nativeWordProcessProvider;
    // Simulated launchers have no genuine Windows command process to monitor.
    this.wordMonitoringEnabled = !options.spawnProcess || Boolean(options.wordProcessProvider);
  }

  attachBackgroundTurbo(service: BackgroundTurboService) { this.backgroundTurbo = service; }

  assess(command: string): RiskAssessment {
    return assessTerminalRisk(command);
  }

  classify(command: string): Risk {
    return this.assess(command).legacyRisk;
  }

  preview(command: string, cwd = "D:\\", timeoutSeconds = 120, environment: Record<string, string> = {}, taskRunId?: string, wordCleanup = true) {
    if (this.config.emergencyStop || !this.config.terminalEnabled) throw new Error("Terminal is disabled.");
    if (!command.trim() || command.length > 20_000) throw new Error("Command is empty or too long.");
    const workdir = this.files.resolvePath(cwd);
    if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new Error("Terminal working directory must be an existing directory.");
    const inspection = this.inspectCommand(command, workdir);
    this.assertPowerShellPolicy(inspection.text);
    if (inspection.referencedScriptPath && !inspection.standaloneScriptPath) {
      throw new Error("POWERSHELL_SCRIPT_RUNNER_REQUIRED: .ps1 fallback must be invoked as one standalone argument-free script (for example: & 'script.ps1'). MCP reads the file as UTF-8 and executes it through -EncodedCommand; nested powershell -File and script arguments are blocked to avoid encoding/quoting ambiguity.");
    }
    const officeMutationHint = this.detectOfficeMutationFromInspection(inspection.text);
    // v0.24.11: chấm cả nội dung script (.ps1) được gọi; lấy mức cao hơn.
    const commandAssessment = this.assess(command);
    const scriptAssessment = inspection.text !== command ? this.assess(inspection.text) : null;
    const assessment = scriptAssessment && scriptAssessment.score > commandAssessment.score
      ? { ...scriptAssessment, reasons: [...scriptAssessment.reasons, "referenced_script_content"] }
      : commandAssessment;
    const risk = assessment.legacyRisk;
    const executionEnvironment = this.validateExecutionEnvironment(environment);
    const environmentFingerprint = JSON.stringify(Object.entries(executionEnvironment).sort(([a], [b]) => a.localeCompare(b)));
    const commandHash = sha256(`${workdir}\n${command}\n${environmentFingerprint}`);
    const taskAuthorization = taskRunId && this.taskAuthorizations ? this.taskAuthorizations.active(taskRunId) : null;
    const taskAuthorizedHigh = Boolean(taskRunId && this.taskAuthorizations?.allows(taskRunId, assessment.level));
    const effectiveConfirmationMode = taskAuthorizedHigh && assessment.level !== "critical" ? "implicit_user_intent" : assessment.confirmationMode;
    const criticalConfirmation = assessment.confirmationMode === "critical_phrase" ? `CONFIRM CRITICAL ${commandHash.slice(0, 12).toUpperCase()}` : null;
    const requestedTimeoutSeconds = Math.min(Math.max(timeoutSeconds, 1), 1800);
    const effectiveTimeoutSeconds = requestedTimeoutSeconds;
    const launchMode = inspection.standaloneScriptPath ? "utf8_encoded_script" : /[^\x00-\x7F]/.test(command) ? "utf8_encoded_command" : "command";
    const pending = this.store.createPending("terminal", { command, cwd: workdir, timeoutSeconds: effectiveTimeoutSeconds, requestedTimeoutSeconds, launchMode, standaloneScriptPath: inspection.standaloneScriptPath, risk, riskScore: assessment.score, riskLevel: assessment.level, confirmationMode: effectiveConfirmationMode, riskReasons: assessment.reasons, commandHash, criticalConfirmation, environment: executionEnvironment, taskRunId: taskRunId ?? null, wordCleanup, taskAuthorizationId: taskAuthorization?.id ?? null }, commandHash);
    this.store.audit("terminal_preview", "pending", { actionId: pending.id, cwd: workdir, risk, riskScore: assessment.score, riskLevel: assessment.level, confirmationMode: assessment.confirmationMode, riskReasons: assessment.reasons, command: redact(command) });
    const advice = /\.docx\b/i.test(inspection.text) && /Document\s*\(|python-docx|from\s+docx\b|\.save\s*\(/i.test(inspection.text)
      ? "Với văn bản theo mẫu hãy dùng doc_from_template + doc_format_check."
      : isReadOnlyFileInspection(command) ? CODE_RUN_ADVICE : undefined;
    return {
      ...(advice ? { advice } : {}),
      actionId: pending.id,
      confirmationToken: pending.confirmationToken,
      expiresAt: pending.expiresAt,
      commandHash,
      cwd: workdir,
      risk,
      riskScore: assessment.score,
      riskLevel: assessment.level,
      confirmationMode: effectiveConfirmationMode,
      requiresUserConfirmationTurn: effectiveConfirmationMode === "explicit_user_confirmation" || effectiveConfirmationMode === "critical_phrase",
      riskReasons: assessment.reasons,
      criticalConfirmation,
      environmentNames: Object.keys(executionEnvironment).sort(),
      timeoutSeconds: effectiveTimeoutSeconds,
      requestedTimeoutSeconds,
      launchMode,
      terminalPolicy: "standard",
      taskRunId: taskRunId ?? null,
      taskAuthorizationId: taskAuthorization?.id ?? null,
      taskAuthorizationActive: Boolean(taskAuthorization?.active),
      taskAuthorizationCoversRisk: taskAuthorizedHigh,
      summary: taskAuthorizedHigh && assessment.level !== "critical" ? "Task-scoped authorization covers this risk level; no extra user confirmation turn is required." : assessment.summary,
    };
  }

  async execute(actionId: string, commandHash: string, confirmationToken: string, criticalConfirmation?: string): Promise<Record<string, unknown>> {
    const pending = this.store.getPending(actionId);
    const taskRunId = typeof pending.payload.taskRunId === "string" ? pending.payload.taskRunId : null;
    const enabled = pending.payload.wordCleanup !== false && wordCleanupEnabled() && this.wordMonitoringEnabled;
    let before: WordProcessInfo[] = [];
    let initialError: string | null = null;
    if (enabled) {
      try { before = await this.wordProcessProvider.list(); }
      catch (error) { initialError = String(error); }
    }
    const startedAt = Date.now();
    const output = await this.executeCore(actionId, commandHash, confirmationToken, criticalConfirmation);
    const endedAt = Date.now();
    if (enabled && !initialError) {
      output.word_cleanup = await cleanWordProcesses({
        before, commandPid: Number(output.pid) || undefined, startedAt, endedAt
      }, this.wordProcessProvider);
    } else {
      output.word_cleanup = { enabled: enabled && !initialError, killed: [], kept: [], errors: initialError ? [initialError] : [] };
    }
    const stale = receiptStaleWarnings(taskRunId);
    if (stale.length) output.warnings = stale;
    return output;
  }

  private async executeCore(actionId: string, commandHash: string, confirmationToken: string, criticalConfirmation?: string): Promise<Record<string, unknown>> {
    if (this.config.emergencyStop || !this.config.terminalEnabled) throw new Error("Terminal is disabled.");
    this.pruneDeadRuns();
    if (this.running.size >= this.maxConcurrentRuns) throw new Error(`At most ${this.maxConcurrentRuns} terminal processes may run concurrently.`);
    const previewed = this.store.getPending(actionId);
    if (previewed.kind !== "terminal") throw new Error("Pending action is not a terminal command.");
    const taskRunId = previewed.payload.taskRunId == null ? "" : String(previewed.payload.taskRunId);
    const riskLevel = String(previewed.payload.riskLevel ?? "minimal") as "minimal" | "low" | "moderate" | "high" | "critical";
    if (riskLevel === "high" && taskRunId && !this.taskAuthorizations?.allows(taskRunId, "high")) throw new Error("Task-scoped authorization is missing or expired for this high-risk command.");
    const pending = this.store.consumePending(actionId, confirmationToken);
    if (pending.kind !== "terminal") throw new Error("Pending action is not a terminal command.");
    if (String(pending.payload.commandHash) !== commandHash || pending.expectedHash !== commandHash) throw new Error("Command hash does not match the preview.");
    if (pending.payload.risk === "critical" && String(pending.payload.criticalConfirmation) !== String(criticalConfirmation ?? "")) {
      throw new Error("Critical command confirmation phrase does not match the preview.");
    }
    const command = String(pending.payload.command);
    const cwd = String(pending.payload.cwd);
    const timeoutSeconds = Number(pending.payload.timeoutSeconds ?? 120);
    const executionEnvironment = this.validateExecutionEnvironment((pending.payload.environment ?? {}) as Record<string, string>);
    const id = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startedAt = nowIso();
    const turboEligible = Boolean(this.backgroundTurbo && ["minimal", "low"].includes(riskLevel) && Object.keys(executionEnvironment).length === 0 && isTurboSafePowerShell(command));
    if (turboEligible) {
      const turbo = await this.backgroundTurbo!.execPowerShellQuery(command, cwd);
      const result = { runId: id, pid: turbo.workerPid, startedAt, completedAt: nowIso(), timedOut: false, truncated: false, stdout: redact(turbo.stdout), stderr: redact(turbo.stderr), code: turbo.code, signal: null, turbo: true, workerElapsedMs: turbo.elapsedMs };
      this.store.audit("terminal_execute", Number(result.code) === 0 ? "success" : "error", { actionId, cwd, taskRunId: taskRunId || null, command: redact(command), ...result });
      return result;
    }
    const result = await new Promise<Record<string, unknown>>((resolvePromise) => {
      const launchMode = String(pending.payload.launchMode ?? "utf8_encoded_command");
      const standaloneScriptPath = pending.payload.standaloneScriptPath == null ? null : String(pending.payload.standaloneScriptPath);
      const launch = this.buildPowerShellLaunch(command, cwd, launchMode, standaloneScriptPath);
      const child = this.spawnProcess("powershell.exe", launch.args, {
        cwd,
        windowsHide: true,
        env: this.safeEnvironment(executionEnvironment),
      });
      this.running.set(id, { pid: child.pid ?? -1, startedAt });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      const maxOutput = 1_000_000;
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString("utf8");
        if (next.length > maxOutput) { truncated = true; return next.slice(0, maxOutput); }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      let timedOut = false;

      const finish = (payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (exitGraceTimer) clearTimeout(exitGraceTimer);
        this.running.delete(id);
        // Descendants started by PowerShell may inherit the launcher's pipe handles.
        // Once PowerShell itself has exited, keeping those handles open must not occupy
        // a terminal concurrency slot indefinitely.
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        resolvePromise({ runId: id, pid: child.pid, startedAt, completedAt: nowIso(), timedOut, truncated, stdout: redact(stdout), stderr: redact(stderr), ...payload });
      };

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      }, timeoutSeconds * 1000);

      child.once("exit", (code, signal) => {
        // `close` normally follows `exit` after stdio drains. Give it a short grace
        // period for final output, but never wait indefinitely on inherited handles.
        this.running.delete(id);
        exitGraceTimer = setTimeout(() => finish({ code, signal }), this.drainGraceMs);
      });
      child.once("close", (code, signal) => finish({ code, signal }));
      child.once("error", (error) => finish({ code: -1, signal: null, error: error.message }));
    });
    const officeMutationHint = Number(result.code) === 0 ? this.detectOfficeMutation(command, cwd) : null;
    if (officeMutationHint) (result as Record<string, unknown>).officeMutationHint = officeMutationHint;
    this.store.audit("terminal_execute", Number(result.code) === 0 ? "success" : "error", { actionId, cwd, taskRunId: taskRunId || null, command: redact(command), officeMutationHint, ...result });
    return result;
  }

  private inspectCommand(command: string, cwd: string): { text: string; standaloneScriptPath: string | null; referencedScriptPath: string | null } {
    let text = command;
    const standaloneScriptPath = this.extractStandaloneScriptPath(command, cwd);
    const referencedScriptPath = this.extractReferencedScriptPath(command, cwd);
    const candidate = standaloneScriptPath ?? referencedScriptPath;
    if (candidate) {
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          const body = readFileSync(candidate, "utf8").replace(/^\uFEFF/, "").slice(0, 500_000);
          text += "\n" + body;
          // v0.24.11: đọc thêm tối đa 5 script được gọi bên trong (1 tầng) để chấm rủi ro.
          const nested = [...body.matchAll(/&\s+(?:"([^"]+\.ps1)"|'([^']+\.ps1)')/gi)].slice(0, 5);
          for (const match of nested) {
            const raw = match[1] || match[2];
            try {
              const inner = this.files.resolvePath(isAbsolutePath(raw) ? raw : resolvePath(cwd, raw));
              if (existsSync(inner) && statSync(inner).isFile()) text += "\n" + readFileSync(inner, "utf8").replace(/^\uFEFF/, "").slice(0, 200_000);
            } catch {}
          }
        }
      } catch {}
    }
    return { text, standaloneScriptPath, referencedScriptPath };
  }

  private extractStandaloneScriptPath(command: string, cwd: string): string | null {
    const trimmed = command.trim();
    const direct = trimmed.match(/^&\s+(?:"([^"]+\.ps1)"|'([^']+\.ps1)'|([^\s]+\.ps1))\s*$/i);
    const nested = trimmed.match(/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-File\s+(?:"([^"]+\.ps1)"|'([^']+\.ps1)'|([^\s]+\.ps1))\s*$/i);
    const raw = direct ? (direct[1] || direct[2] || direct[3]) : nested ? (nested[1] || nested[2] || nested[3]) : "";
    if (!raw) return null;
    const resolved = isAbsolutePath(raw) ? raw : resolvePath(cwd, raw);
    try { return this.files.resolvePath(resolved); } catch { return null; }
  }

  private extractReferencedScriptPath(command: string, cwd: string): string | null {
    const match = command.match(/(?:-File|&)\s+(?:"([^"]+\.ps1)"|'([^']+\.ps1)'|([^\s]+\.ps1))/i);
    const raw = match ? (match[1] || match[2] || match[3]) : "";
    if (!raw) return null;
    const resolved = isAbsolutePath(raw) ? raw : resolvePath(cwd, raw);
    try { return this.files.resolvePath(resolved); } catch { return null; }
  }

  private assertPowerShellPolicy(inspection: string) {
    if (/(?:^|[^A-Za-z0-9_-])(?:Invoke-Expression|IEX)(?:\s|$|\()/im.test(inspection)) {
      throw new Error("POWERSHELL_POLICY_BLOCKED: Invoke-Expression/IEX is not allowed. Use a direct command or a standalone UTF-8 .ps1 file; the terminal runner will execute standalone scripts via -EncodedCommand.");
    }
  }

  private detectOfficeMutation(command: string, cwd: string) {
    return this.detectOfficeMutationFromInspection(this.inspectCommand(command, cwd).text);
  }

  private detectOfficeMutationFromInspection(inspection: string) {
    const lower = inspection.toLowerCase();
    const application = lower.includes("word.application") || lower.includes("activedocument") ? "word"
      : lower.includes("excel.application") || lower.includes("activeworkbook") ? "excel"
      : lower.includes("powerpoint.application") || lower.includes("activepresentation") ? "powerpoint"
      : null;
    if (!application) return null;
    const mutation = /\.save\b|\.saveas\b|\.text\s*=|\.font\.|paragraphformat|pagesetup|headers|footers|tables|selection\.|range\./i.test(inspection);
    if (!mutation) return null;
    const matches = inspection.match(/[A-Za-z]:\\[^'"\r\n]+?\.(?:docx|docm|doc|xlsx|xlsm|xls|pptx|pptm|ppt)/gi) ?? [];
    const paths = [...new Set(matches.map((item) => item.trim()))].slice(0, 20);
    return { application, paths, source: "terminal_com_fallback" };
  }

  private buildPowerShellLaunch(command: string, cwd: string, launchMode: string, standaloneScriptPath: string | null) {
    if (launchMode === "command") {
      return { args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", command] };
    }
    let body = command;
    if (launchMode === "utf8_encoded_script" && standaloneScriptPath) {
      const resolved = this.files.resolvePath(isAbsolutePath(standaloneScriptPath) ? standaloneScriptPath : resolvePath(cwd, standaloneScriptPath));
      body = readFileSync(resolved, "utf8").replace(/^\uFEFF/, "");
      this.assertPowerShellPolicy(body);
    }
    const preamble = "$utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; ";
    const encoded = Buffer.from(preamble + body, "utf16le").toString("base64");
    return { args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-EncodedCommand", encoded] };
  }

  cancel(runId: string) {
    this.pruneDeadRuns();
    const running = this.running.get(runId);
    if (!running) throw new Error("Run is not active.");
    const pid = running.pid;
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    let checked = false;
    const reconcile = (taskkillCode: number | null) => {
      if (checked) return;
      checked = true;
      if (!this.isProcessAlive(pid)) this.running.delete(runId);
      const alive = this.running.has(runId);
      this.store.audit("terminal_cancel", alive ? "failed" : "completed", { runId, pid, taskkillCode, alive });
    };
    killer.once("close", (code) => reconcile(code));
    killer.once("error", () => reconcile(-1));
    setTimeout(() => reconcile(null), 3000).unref?.();
    this.store.audit("terminal_cancel", "requested", { runId, pid });
    return { cancelled: true, runId, pid };
  }

  listRunning() {
    this.pruneDeadRuns();
    return [...this.running.entries()].map(([runId, value]) => ({ runId, ...value }));
  }

  private pruneDeadRuns() {
    for (const [runId, value] of this.running) {
      if (this.isProcessAlive(value.pid)) continue;
      this.running.delete(runId);
      this.store.audit("terminal_run", "stale_pruned", { runId, pid: value.pid, startedAt: value.startedAt });
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    return this.processAliveProbe(pid);
  }

  private validateExecutionEnvironment(environment: Record<string, string>): Record<string, string> {
    const allowed = new Set(["NODE_ENV", "PYTHONUTF8", "PYTHONIOENCODING"]);
    const safe: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(environment ?? {})) {
      const name = rawName.toUpperCase();
      if (!allowed.has(name)) throw new Error(`Terminal environment variable '${rawName}' is not allowed.`);
      const value = String(rawValue);
      if (value.length > 2000 || /[\r\n\0]/.test(value)) throw new Error(`Terminal environment variable '${rawName}' has an invalid value.`);
      safe[name] = value;
    }
    return safe;
  }

  private safeEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const allowed = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"];
    const base = Object.fromEntries(allowed.map((key) => [key, process.env[key]]).filter((entry) => entry[1])) as NodeJS.ProcessEnv;
    return { ...base, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...this.validateExecutionEnvironment(extra) };
  }
}


