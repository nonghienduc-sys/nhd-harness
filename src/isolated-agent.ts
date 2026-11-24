import { assertPaymentAction, isPaymentAction } from "./payment-policy.js";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Store } from "./db.js";
import { TaskAuthorizationService } from "./task-authorization.js";
import type { IsolatedLaneStatus } from "./execution-lanes.js";

export type IsolatedAgentCommand = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  taskRunId: string | null;
  createdAt: string;
};

export type IsolatedBrowserControl = {
  selectorId: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  type: string;
  href: string;
  value?: string;
  disabled?: boolean;
  formAssociated?: boolean;
  download?: boolean;
  bounds?: { x: number; y: number; width: number; height: number } | null;
};

type SelectorCache = { meta: IsolatedBrowserControl; expiresAt: number };
type DesktopSelectorCache = { windowId: string; selectorId: string; name: string; automationId: string; className: string; controlType: string; enabled: boolean; offscreen: boolean; password: boolean; expiresAt: number };

type IsolatedRisk = { level: "low" | "moderate" | "high" | "blocked"; category: string; reason: string };

type DirectPending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; startedAt: number; type: string };

const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SENSITIVE_ACTION = /\b(send|message|email|delete|remove|purchase|checkout|pay|payment|transfer|wire|call|video\s*call|change\s+password|account\s+security|publish|post)\b/i;
const COMMIT_ACTION = /\b(submit|save|create|update|apply|confirm|continue|next|finish|complete|sign\s*in|log\s*in)\b/i;
const SENSITIVE_FIELD = /\b(password|passcode|otp|cvv|cvc|card\s*number|credit\s*card|bank\s*account|routing\s*number|secret|token)\b/i;

function bounded(value: unknown, max: number, name: string, allowEmpty = false) {
  const text = String(value ?? "").trim();
  if ((!allowEmpty && !text) || text.length > max) throw new Error(`${name} is empty or exceeds ${max} characters.`);
  return text;
}
function xmlEscape(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function sleep(ms: number) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }

export class IsolatedAgentService {
  readonly exchangeRoot: string;
  readonly agentRoot: string;
  readonly sandboxConfigPath: string;
  private readonly inbox: string;
  private readonly outbox: string;
  private readonly heartbeatPath: string;
  private readonly selectorCache = new Map<string, SelectorCache>();
  private readonly desktopSelectorCache = new Map<string, DesktopSelectorCache>();
  private readonly desktopWorkflowId = `nhd-desktop-${randomBytes(8).toString("hex")}`;
  private desktopUiLastRttMs: number | null = null;
  private sandboxLauncherPid: number | null = null;
  private transport: ChildProcessWithoutNullStreams | null = null;
  private transportStarting: Promise<void> | null = null;
  private transportBuffer = "";
  private transportStderr = "";
  private transportReady = false;
  private transportSessionId: string | null = null;
  private transportVersion: string | null = null;
  private transportLastHeartbeatAt: string | null = null;
  private transportBusy = false;
  private transportBrowser: unknown = null;
  private transportDesktopWorker: unknown = null;
  private transportStartupMs: number | null = null;
  private transportLastRttMs: number | null = null;
  private readonly transportPending = new Map<string, DirectPending>();

  constructor(readonly store: Store, readonly authorizations: TaskAuthorizationService, exchangeRoot = process.env.NHD_AGENT_EXCHANGE_ROOT || (existsSync("D:\\") ? "D:\\NHD-Agent-Exchange" : resolve(process.cwd(), "NHD-Agent-Exchange"))) {
    this.exchangeRoot = resolve(exchangeRoot);
    this.agentRoot = resolve(process.cwd(), "isolated-agent");
    this.sandboxConfigPath = resolve(this.agentRoot, "NHD-Isolated-Agent.wsb");
    this.inbox = resolve(this.exchangeRoot, "commands");
    this.outbox = resolve(this.exchangeRoot, "responses");
    this.heartbeatPath = resolve(this.exchangeRoot, "heartbeat.json");
    this.ensureLayout();
  }

  status(): IsolatedLaneStatus & Record<string, unknown> {
    const sandboxExe = this.sandboxExecutable();
    const nodeDir = this.nodeDirectory();
    const winappExe = this.winappNativeExecutable();
    const bootstrap = this.readHeartbeat();
    const bootstrapAt = bootstrap?.at ? String(bootstrap.at) : null;
    const bootstrapOnline = bootstrapAt ? Date.now() - Date.parse(bootstrapAt) < 20_000 : false;
    const directOnline = this.directOnline();
    return {
      provider: "windows-sandbox",
      featureAvailable: Boolean(sandboxExe),
      configured: Boolean(sandboxExe && nodeDir && winappExe && existsSync(this.agentRoot)),
      online: directOnline,
      busy: this.transportBusy,
      lastHeartbeatAt: this.transportLastHeartbeatAt,
      detail: !sandboxExe
        ? "Windows Sandbox feature is not enabled on this host."
        : !nodeDir
          ? "A host Node.js runtime was not found for the mapped isolated companion."
          : !winappExe
            ? "Microsoft WinApp CLI native executable was not found."
            : directOnline
              ? "Isolated Agent direct WinApp stdio transport is online."
              : bootstrapOnline
                ? "Sandbox bootstrap is online; direct WinApp stdio transport is not connected."
                : "Windows Sandbox is configured but the isolated companion is offline.",
      sandboxExecutable: sandboxExe,
      winappExecutable: winappExe,
      nodeDirectory: nodeDir,
      exchangeRoot: this.exchangeRoot,
      sandboxConfigPath: this.sandboxConfigPath,
      agentVersion: this.transportVersion ?? bootstrap?.version ?? null,
      sessionId: this.transportSessionId ?? null,
      browser: this.transportBrowser ?? null,
      desktopWorker: { backend: "winapp-ui", persistentProcess: false, workflowContinuity: true },
      desktopTransport: { mode: "winapp-ui-workflow", online: bootstrapOnline || directOnline, workflowId: this.desktopWorkflowId, lastRttMs: this.desktopUiLastRttMs },
      launcherPid: this.sandboxLauncherPid,
      bootstrap: { online: bootstrapOnline, lastHeartbeatAt: bootstrapAt, mode: bootstrap?.mode ?? null, pid: bootstrap?.pid ?? null },
      transport: { mode: "winapp-stdio", online: directOnline, pid: this.transport?.pid ?? null, startupMs: this.transportStartupMs, lastRttMs: this.transportLastRttMs, stderrTail: this.transportStderr.slice(-1000) },
    };
  }

  generateSandboxConfig(memoryMb = 3072) {
    const sandboxExe = this.sandboxExecutable();
    if (!sandboxExe) throw new Error("Windows Sandbox is not enabled. Enable the Containers-DisposableClientVM optional feature first.");
    const nodeDir = this.nodeDirectory();
    if (!nodeDir) throw new Error("Node.js runtime directory was not found on the host.");
    if (!existsSync(resolve(this.agentRoot, "agent.mjs"))) throw new Error("Isolated Agent companion source is missing.");
    this.ensureLayout();
    const boundedMemory = Math.max(2048, Math.min(Math.floor(memoryMb), 6144));
    const command = `cmd /d /s /c \"set NHD_AGENT_EXCHANGE=C:\\NHD\\Exchange&& C:\\NHD\\Node\\node.exe C:\\NHD\\Agent\\agent.mjs --bootstrap\"`;
    const xml = `<Configuration>\n  <MemoryInMB>${boundedMemory}</MemoryInMB>\n  <vGPU>Disable</vGPU>\n  <Networking>Enable</Networking>\n  <ClipboardRedirection>Disable</ClipboardRedirection>\n  <PrinterRedirection>Disable</PrinterRedirection>\n  <AudioInput>Disable</AudioInput>\n  <VideoInput>Disable</VideoInput>\n  <MappedFolders>\n    <MappedFolder><HostFolder>${xmlEscape(this.agentRoot)}</HostFolder><SandboxFolder>C:\\NHD\\Agent</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>\n    <MappedFolder><HostFolder>${xmlEscape(nodeDir)}</HostFolder><SandboxFolder>C:\\NHD\\Node</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>\n    <MappedFolder><HostFolder>${xmlEscape(this.exchangeRoot)}</HostFolder><SandboxFolder>C:\\NHD\\Exchange</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>\n  </MappedFolders>\n  <LogonCommand><Command>${xmlEscape(command)}</Command></LogonCommand>\n</Configuration>\n`;
    writeFileSync(this.sandboxConfigPath, xml, "utf8");
    this.store.audit("isolated_agent_config", "generated", { provider: "windows-sandbox", memoryMb: boundedMemory, config: this.sandboxConfigPath });
    return { provider: "windows-sandbox", memoryMb: boundedMemory, configPath: this.sandboxConfigPath, exchangeRoot: this.exchangeRoot };
  }

  async start(input: { memoryMb?: number; timeoutMs?: number } = {}) {
    if (this.directOnline()) return this.status();
    const timeoutMs = Math.max(5_000, Math.min(input.timeoutMs ?? 90_000, 180_000));
    if (this.bootstrapOnline()) {
      await this.ensureDirectTransport(Math.min(timeoutMs, 15_000));
      return this.status();
    }
    const sandboxExe = this.sandboxExecutable();
    if (!sandboxExe) throw new Error("Windows Sandbox feature is unavailable. Host foreground fallback is forbidden; enable Windows Sandbox before using Isolated Agent.");
    this.generateSandboxConfig(input.memoryMb ?? 3072);
    this.disposeTransport(new Error("Isolated transport reset before Sandbox launch."), true);
    try { rmSync(this.heartbeatPath, { force: true }); } catch { }
    const child = spawn(sandboxExe, [this.sandboxConfigPath], { detached: true, windowsHide: false, stdio: "ignore" });
    this.sandboxLauncherPid = child.pid ?? null;
    child.unref();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.bootstrapOnline()) {
        await this.ensureDirectTransport(Math.max(5_000, timeoutMs - (Date.now() - started)));
        this.store.audit("isolated_agent", "online", { provider: "windows-sandbox", transport: "winapp-stdio", launcherPid: this.sandboxLauncherPid, waitedMs: Date.now() - started });
        return this.status();
      }
      await sleep(250);
    }
    throw new Error("Windows Sandbox launched but bootstrap/direct transport did not become healthy before timeout. The launch is not replayed automatically.");
  }

  async stop(taskRunId?: string) {
    const status = this.status();
    if (!status.online) return { stopped: true, alreadyOffline: true };
    const result = await this.send("system.shutdown", {}, taskRunId ?? null, 15_000);
    this.selectorCache.clear();
    return { stopped: true, result };
  }

  async browserStatus() { return this.send("browser.status", {}, null, 8_000); }
  async browserNavigate(urlInput: string, taskRunId?: string) {
    assertPaymentAction(urlInput);
    const url = new URL(urlInput);
    if (!(["http:", "https:"].includes(url.protocol))) throw new Error("Isolated browser navigation accepts HTTP/HTTPS only.");
    this.selectorCache.clear();
    return this.send("browser.navigate", { url: url.toString() }, taskRunId ?? null, 20_000);
  }
  async browserSnapshot(maxChars = 50_000) { return this.send("browser.snapshot", { maxChars: Math.max(1_000, Math.min(maxChars, 100_000)) }, null, 12_000); }
  async browserInspect(query = "", limit = 200) {
    const result = await this.send("browser.inspect", { query: String(query).slice(0, 500), limit: Math.max(1, Math.min(Math.floor(limit), 500)) }, null, 12_000) as Record<string, unknown>;
    const controls = Array.isArray(result.controls) ? result.controls as IsolatedBrowserControl[] : [];
    const expiresAt = Date.now() + 5 * 60_000;
    for (const control of controls) if (control?.selectorId) this.selectorCache.set(String(control.selectorId), { meta: control, expiresAt });
    this.pruneSelectors();
    return result;
  }
  async browserClick(selectorIdInput: string, taskRunId?: string) {
    const selectorId = bounded(selectorIdInput, 256, "selectorId");
    const cached = this.selector(selectorId);
    const risk = this.assessBrowserClick(cached.meta);
    this.requireAuthorization(risk, taskRunId);
    const result = await this.send("browser.click", { selectorId }, taskRunId ?? null, 15_000);
    this.selectorCache.clear();
    this.store.audit("isolated_browser_click", "success", { selectorId, risk, taskRunId: taskRunId ?? null });
    return { result, risk };
  }
  async browserFill(selectorIdInput: string, textInput: string) {
    const selectorId = bounded(selectorIdInput, 256, "selectorId");
    const text = String(textInput ?? "").slice(0, 2_000);
    const cached = this.selector(selectorId);
    const description = `${cached.meta.type} ${cached.meta.name} ${cached.meta.text}`;
    assertPaymentAction(description);
    if (cached.meta.type === "password" || cached.meta.type === "file" || SENSITIVE_FIELD.test(description)) throw new Error("Sensitive/password/file/payment fields are blocked in Isolated Agent.");
    const result = await this.send("browser.fill", { selectorId, text }, null, 12_000);
    return { result, characters: text.length };
  }
  async browserPress(keyInput: string, taskRunId?: string) {
    const key = bounded(keyInput, 40, "key").toUpperCase();
    const allowed = new Set(["ESCAPE","ENTER","TAB","SHIFT_TAB","ARROW_UP","ARROW_DOWN","ARROW_LEFT","ARROW_RIGHT","PAGE_UP","PAGE_DOWN","HOME","END","SPACE"]);
    if (!allowed.has(key)) throw new Error("Unsupported isolated browser key.");
    const risk: IsolatedRisk = key === "ENTER" ? { level: "moderate", category: "ordinary_commit", reason: "Enter can submit the focused form." } : { level: "low", category: "navigation", reason: "Approved navigation key." };
    this.requireAuthorization(risk, taskRunId);
    return { result: await this.send("browser.press", { key }, taskRunId ?? null, 10_000), risk };
  }
  async browserScreenshot() { return this.send("browser.screenshot", {}, null, 15_000); }

  async desktopList() {
    const raw = await this.runWinAppUi(["list-windows"]) as unknown;
    const rows = Array.isArray(raw) ? raw as Record<string, unknown>[] : [];
    const windows = rows.map((row) => ({
      windowId: String(row.hwnd ?? ""),
      title: String(row.title ?? ""),
      processId: Number(row.processId ?? 0),
      processName: String(row.processName ?? ""),
      className: String(row.className ?? ""),
      isForeground: Boolean(row.isForeground),
      bounds: { x: null, y: null, width: Number(row.width ?? 0), height: Number(row.height ?? 0) },
    })).filter((row) => /^\d+$/.test(row.windowId));
    return { windows, count: windows.length, backend: { mode: "winapp-ui-workflow", workflowContinuity: true } };
  }

  async desktopInspect(windowIdInput: string, query = "", limit = 300) {
    const windowId = bounded(windowIdInput, 128, "windowId");
    if (!/^\d+$/.test(windowId)) throw new Error("windowId must be a numeric Sandbox HWND.");
    const boundedLimit = Math.max(20, Math.min(Math.floor(limit), 1000));
    const q = String(query ?? "").trim().slice(0, 500);
    let raw: Record<string, unknown>;
    let items: Record<string, unknown>[] = [];
    let truncated = false;
    if (q) {
      raw = await this.runWinAppUi(["search", q, "-w", windowId, "--max", String(boundedLimit)]) as Record<string, unknown>;
      items = Array.isArray(raw.matches) ? raw.matches as Record<string, unknown>[] : [];
      truncated = Boolean(raw.hasMore);
    } else {
      raw = await this.runWinAppUi(["inspect", "-w", windowId, "--depth", "8"]) as Record<string, unknown>;
      const windows = Array.isArray(raw.windows) ? raw.windows as Record<string, unknown>[] : [];
      const visit = (node: Record<string, unknown>) => {
        if (items.length >= boundedLimit) { truncated = true; return; }
        if (node.selector) items.push(node);
        const children = Array.isArray(node.children) ? node.children as Record<string, unknown>[] : [];
        for (const child of children) { if (items.length >= boundedLimit) { truncated = true; break; } visit(child); }
      };
      for (const win of windows) {
        const elements = Array.isArray(win.elements) ? win.elements as Record<string, unknown>[] : [];
        for (const element of elements) { if (items.length >= boundedLimit) { truncated = true; break; } visit(element); }
      }
    }
    const expiresAt = Date.now() + 5 * 60_000;
    const controls = items.slice(0, boundedLimit).map((item) => {
      const selectorId = String(item.selector ?? "").slice(0, 256);
      const meta: DesktopSelectorCache = {
        windowId, selectorId, name: String(item.name ?? "").slice(0, 500), automationId: String(item.automationId ?? "").slice(0, 300),
        className: String(item.className ?? "").slice(0, 300), controlType: String(item.type ?? "").slice(0, 100),
        enabled: item.isEnabled !== false, offscreen: Boolean(item.isOffscreen), password: Boolean(item.isPassword), expiresAt,
      };
      if (selectorId) this.desktopSelectorCache.set(`${windowId}:${selectorId}`, meta);
      return { selectorId, name: meta.name, automationId: meta.automationId, className: meta.className, controlType: meta.controlType,
        enabled: meta.enabled, offscreen: meta.offscreen, password: meta.password,
        bounds: { x: Number(item.x ?? 0), y: Number(item.y ?? 0), width: Number(item.width ?? 0), height: Number(item.height ?? 0) },
        invokable: Boolean(item.isInvokable) };
    }).filter((item) => item.selectorId);
    this.pruneDesktopSelectors();
    return { windowId, controls, returned: controls.length, truncated, backend: { mode: "winapp-ui-workflow", workflowContinuity: true } };
  }

  async desktopScreenshot() {
    const listed = await this.desktopList() as { windows: Array<{ windowId: string; isForeground?: boolean; bounds?: { width?: number; height?: number } }> };
    const target = listed.windows.find((item) => item.isForeground) ?? [...listed.windows].sort((a,b) => ((b.bounds?.width ?? 0)*(b.bounds?.height ?? 0))-((a.bounds?.width ?? 0)*(a.bounds?.height ?? 0)))[0];
    if (!target) throw new Error("No visible Sandbox window is available for screenshot.");
    const name = `desktop-winapp-${Date.now()}-${randomBytes(4).toString("hex")}.png`;
    const path = resolve(this.exchangeRoot, "screenshots", name);
    const raw = await this.runWinAppUi(["screenshot", "-w", target.windowId, "-o", path], 20_000) as Record<string, unknown>;
    const returned = resolve(String(raw.filePath ?? path));
    if (!returned.startsWith(this.exchangeRoot) || !existsSync(returned)) throw new Error("WinApp UI screenshot file was not found inside the exchange root.");
    return { ...raw, relativePath: returned.slice(this.exchangeRoot.length + 1), mimeType: "image/png", data: readFileSync(returned).toString("base64"), backend: { mode: "winapp-ui-workflow" } };
  }

  async desktopAction(input: { action: "invoke" | "set_text" | "press_key" | "click_point"; windowId?: string; selectorId?: string; text?: string; key?: string; xRatio?: number; yRatio?: number; taskRunId?: string }) {
    const description = `${input.action} ${input.selectorId ?? ""} ${input.key ?? ""}`;
    let risk: IsolatedRisk = { level: input.action === "click_point" ? "high" : "moderate", category: "isolated_gui_action", reason: "GUI mutation occurs only inside the isolated desktop." };
    if (SENSITIVE_ACTION.test(description)) risk = { level: "high", category: "sensitive_gui_action", reason: "The isolated GUI action may have a sensitive external side effect." };
    this.requireAuthorization(risk, input.taskRunId);
    const windowId = input.windowId ? bounded(input.windowId, 128, "windowId") : "";
    if (!windowId || !/^\d+$/.test(windowId)) throw new Error("A numeric Sandbox windowId is required for isolated desktop actions.");
    if (input.action === "click_point") throw new Error("Normalized coordinate clicks are disabled in the WinApp UI backend; inspect the window and use an accessible selector instead.");
    let result: unknown;
    if (input.action === "invoke") {
      const selectorId = bounded(input.selectorId, 256, "selectorId");
      const meta = this.desktopSelector(windowId, selectorId);
      assertPaymentAction(`${meta.controlType} ${meta.name} ${meta.automationId} ${meta.className}`);
      result = await this.runWinAppUi(["invoke", selectorId, "-w", windowId], 15_000);
      this.desktopSelectorCache.clear();
    } else if (input.action === "set_text") {
      const selectorId = bounded(input.selectorId, 256, "selectorId");
      const meta = this.desktopSelector(windowId, selectorId);
      const descriptor = `${meta.controlType} ${meta.name} ${meta.automationId} ${meta.className}`;
      assertPaymentAction(descriptor);
      if (meta.password || SENSITIVE_FIELD.test(descriptor)) throw new Error("Sensitive/password/payment fields are blocked in Isolated Agent.");
      const text = String(input.text ?? "").slice(0, 2_000);
      result = await this.runWinAppUi(["set-value", selectorId, text, "-w", windowId], 15_000);
      this.desktopSelectorCache.clear();
    } else {
      const key = bounded(input.key, 40, "key").toUpperCase();
      const keyMap: Record<string,string> = { ESCAPE:"esc", TAB:"tab", SHIFT_TAB:"shift+tab", UP:"up", DOWN:"down", LEFT:"left", RIGHT:"right", PAGE_UP:"pageup", PAGE_DOWN:"pagedown", HOME:"home", END:"end", ENTER:"enter", SPACE:"space" };
      const token = keyMap[key];
      if (!token) throw new Error("Unsupported isolated desktop key.");
      result = await this.runWinAppUi(["send-keys", token, "-w", windowId, "--via", "post-message"], 15_000);
      this.desktopSelectorCache.clear();
    }
    this.store.audit("isolated_desktop_action", "success", { action: input.action, windowId, selectorId: input.selectorId ?? null, risk, taskRunId: input.taskRunId ?? null, backend: "winapp-ui-workflow" });
    return { result, risk, backend: { mode: "winapp-ui-workflow" } };
  }

  async ping() { return this.send("system.ping", {}, null, 5_000); }

  private async runWinAppUi(args: string[], timeoutMs = 15_000): Promise<unknown> {
    const exe = this.winappNativeExecutable();
    if (!exe) throw new Error("Microsoft WinApp CLI native executable is unavailable.");
    const started = Date.now();
    return new Promise((resolvePromise, reject) => {
      const child = spawn(exe, ["ui", ...args, "--on", "sandbox", "--json"], {
        cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: "1", WINAPP_UI_WORKFLOW_ID: this.desktopWorkflowId },
      });
      let stdout = "", stderr = "", settled = false;
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-2_000_000); });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-20_000); });
      const timer = setTimeout(() => {
        if (settled) return; settled = true; try { child.kill(); } catch { }
        reject(new Error(`WinApp UI command timed out: ${args[0]}. A side effect may be ambiguous and is not replayed automatically.`));
      }, Math.max(1_000, Math.min(timeoutMs, 30_000)));
      child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(new Error(`WinApp UI command failed to start: ${error.message}`)); });
      child.once("exit", (code, signal) => {
        if (settled) return; settled = true; clearTimeout(timer); this.desktopUiLastRttMs = Date.now() - started;
        if (code !== 0) return reject(new Error(`WinApp UI command failed (code=${code ?? "null"}, signal=${signal ?? "null"}): ${stderr.slice(-2000) || stdout.slice(-2000)}`));
        try { resolvePromise(stdout.trim() ? JSON.parse(stdout.trim()) : {}); }
        catch { reject(new Error(`WinApp UI returned invalid JSON for ${args[0]}: ${stdout.slice(-2000)}`)); }
      });
    });
  }

  private desktopSelector(windowId: string, selectorId: string) {
    this.pruneDesktopSelectors();
    const item = this.desktopSelectorCache.get(`${windowId}:${selectorId}`);
    if (!item) throw new Error("Isolated desktop selector expired or belongs to another window; inspect again.");
    return item;
  }

  private pruneDesktopSelectors() {
    const now = Date.now();
    for (const [key, value] of this.desktopSelectorCache) if (value.expiresAt < now) this.desktopSelectorCache.delete(key);
  }

  private async send(type: string, payload: Record<string, unknown>, taskRunId: string | null, timeoutMs: number): Promise<unknown> {
    if (!this.directOnline()) {
      if (!this.bootstrapOnline()) throw new Error("Isolated Agent direct transport is offline. Host desktop fallback is forbidden.");
      await this.ensureDirectTransport(Math.min(Math.max(timeoutMs, 3_000), 15_000));
    }
    const transport = this.transport;
    if (!transport || !this.transportReady) throw new Error("Isolated Agent direct transport is unavailable. Host desktop fallback is forbidden.");
    const commandId = `cmd-${randomBytes(12).toString("hex")}`;
    const command: IsolatedAgentCommand = { id: commandId, type: bounded(type, 100, "command type"), payload, taskRunId, createdAt: new Date().toISOString() };
    return new Promise((resolvePromise, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        if (!this.transportPending.delete(commandId)) return;
        reject(new Error(`Isolated Agent command timed out: ${type}. The command is not replayed automatically.`));
      }, timeoutMs);
      this.transportPending.set(commandId, { resolve: resolvePromise, reject, timer, startedAt, type });
      transport.stdin.write(`${JSON.stringify({ kind: "command", ...command })}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.transportPending.get(commandId);
        if (!pending) return;
        this.transportPending.delete(commandId);
        clearTimeout(pending.timer);
        reject(new Error(`Isolated Agent transport write failed for ${type}; the command is not replayed because delivery may be ambiguous: ${error.message}`));
      });
    });
  }

  private async ensureDirectTransport(timeoutMs = 10_000) {
    if (this.directOnline()) return;
    if (this.transportStarting) return this.transportStarting;
    this.transportStarting = this.startDirectTransport(timeoutMs).finally(() => { this.transportStarting = null; });
    return this.transportStarting;
  }

  private async startDirectTransport(timeoutMs: number) {
    const exe = this.winappNativeExecutable();
    if (!exe) throw new Error("Microsoft WinApp CLI native executable is unavailable.");
    this.disposeTransport(new Error("Replacing stale Isolated Agent transport."), true);
    this.transportBuffer = "";
    this.transportStderr = "";
    this.transportReady = false;
    this.transportSessionId = null;
    this.transportVersion = null;
    this.transportLastHeartbeatAt = null;
    this.transportBusy = false;
    this.transportBrowser = null;
    this.transportDesktopWorker = null;
    const started = Date.now();
    const child = spawn(exe, ["target", "exec", "sandbox", "--", "C:\\NHD\\Node\\node.exe", "C:\\NHD\\Agent\\agent.mjs", "--stdio"], {
      cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: "1" },
    });
    this.transport = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeTransportChunk(chunk));
    child.stderr.on("data", (chunk: string) => { this.transportStderr = `${this.transportStderr}${chunk}`.slice(-8_000); });
    child.once("exit", (code, signal) => {
      if (this.transport !== child) return;
      this.transport = null;
      this.transportReady = false;
      this.transportLastHeartbeatAt = null;
      const error = new Error(`Isolated Agent direct transport exited (code=${code ?? "null"}, signal=${signal ?? "null"}). Pending commands are not replayed.`);
      this.rejectTransportPending(error);
      this.store.audit("isolated_transport", "disconnected", { code, signal, stderrTail: this.transportStderr.slice(-1000) });
    });
    const boundedTimeout = Math.max(2_000, Math.min(timeoutMs, 30_000));
    while (Date.now() - started < boundedTimeout) {
      if (this.transportReady && this.transport === child) {
        this.transportStartupMs = Date.now() - started;
        this.store.audit("isolated_transport", "connected", { mode: "winapp-stdio", pid: child.pid ?? null, startupMs: this.transportStartupMs, sessionId: this.transportSessionId, version: this.transportVersion });
        return;
      }
      if (child.exitCode != null) throw new Error(`Isolated Agent direct transport exited before ready: ${this.transportStderr.slice(-2000)}`);
      await sleep(25);
    }
    this.disposeTransport(new Error("Isolated Agent direct transport readiness timeout; no command was sent."), true);
    throw new Error(`Isolated Agent direct transport did not become ready within ${boundedTimeout} ms.`);
  }

  private consumeTransportChunk(chunk: string) {
    this.transportBuffer += chunk;
    while (true) {
      const index = this.transportBuffer.indexOf("\n");
      if (index < 0) break;
      const line = this.transportBuffer.slice(0, index).trim();
      this.transportBuffer = this.transportBuffer.slice(index + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { this.transportStderr = `${this.transportStderr}\n[unparsed stdout] ${line}`.slice(-8_000); continue; }
      const kind = String(message.kind ?? "");
      if (kind === "ready" || kind === "heartbeat") {
        this.transportSessionId = message.sessionId ? String(message.sessionId) : this.transportSessionId;
        this.transportVersion = message.version ? String(message.version) : this.transportVersion;
        this.transportLastHeartbeatAt = message.at ? String(message.at) : new Date().toISOString();
        this.transportBusy = Boolean(message.busy);
        this.transportBrowser = message.browser ?? this.transportBrowser;
        this.transportDesktopWorker = message.desktopWorker ?? this.transportDesktopWorker;
        if (kind === "ready") this.transportReady = true;
        continue;
      }
      if (kind !== "response") continue;
      const id = String(message.id ?? "");
      const pending = this.transportPending.get(id);
      if (!pending) continue;
      this.transportPending.delete(id);
      clearTimeout(pending.timer);
      this.transportLastRttMs = Date.now() - pending.startedAt;
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(String(message.error ?? `Isolated Agent command failed: ${pending.type}`)));
    }
  }

  private rejectTransportPending(error: Error) {
    for (const pending of this.transportPending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.transportPending.clear();
  }

  private disposeTransport(reason: Error, kill: boolean) {
    const child = this.transport;
    this.transport = null;
    this.transportReady = false;
    this.transportLastHeartbeatAt = null;
    this.transportBusy = false;
    this.rejectTransportPending(reason);
    if (child && kill && child.exitCode == null) { try { child.kill(); } catch { } }
  }

  private directOnline() {
    if (!this.transport || !this.transportReady || this.transport.exitCode != null || !this.transportLastHeartbeatAt) return false;
    return Date.now() - Date.parse(this.transportLastHeartbeatAt) < 6_000;
  }

  private bootstrapOnline() {
    const heartbeat = this.readHeartbeat();
    if (!heartbeat?.at) return false;
    return Date.now() - Date.parse(String(heartbeat.at)) < 20_000;
  }

  private winappNativeExecutable() {
    const rid = process.arch === "arm64" ? "win-arm64" : "win-x64";
    const path = resolve(process.cwd(), "node_modules", "@microsoft", "winappcli", "bin", rid, "winapp.exe");
    return existsSync(path) ? path : null;
  }

  private requireAuthorization(risk: IsolatedRisk, taskRunId?: string) {
    if (risk.level === "blocked") throw new Error(risk.reason);
    if (risk.level === "low") return;
    if (!taskRunId || !SAFE_ID.test(taskRunId)) throw new Error(`Isolated ${risk.category} action requires an active task-scoped ${risk.level} authorization.`);
    if (!this.authorizations.allows(taskRunId, risk.level)) throw new Error(`Task ${taskRunId} does not have active ${risk.level} authorization for isolated action '${risk.category}'.`);
  }

  private assessBrowserClick(meta: IsolatedBrowserControl): IsolatedRisk {
    const description = `${meta.role} ${meta.name} ${meta.text} ${meta.href}`;
    if (isPaymentAction(description)) return { level: "blocked", category: "payment", reason: "PAYMENT_BLOCKED: payment action is platform-hard-denied." };
    if (meta.type === "file") return { level: "blocked", category: "file_upload", reason: "File picker controls are blocked until a dedicated upload protocol is implemented." };
    if (/^(?:javascript|mailto|tel|sms):/i.test(meta.href || "")) return { level: "blocked", category: "external_protocol", reason: "Script/external-protocol links are blocked." };
    if (meta.download) return { level: "moderate", category: "download", reason: "Download changes isolated task artifacts and therefore requires task scope." };
    if (SENSITIVE_ACTION.test(description)) return { level: "high", category: "sensitive_external_action", reason: "The control can trigger a sensitive external side effect." };
    if (meta.formAssociated || meta.type === "submit" || COMMIT_ACTION.test(description)) return { level: "moderate", category: "ordinary_commit", reason: "The control can commit or submit page state." };
    return { level: "low", category: "safe_navigation", reason: "Routine isolated browser navigation." };
  }

  private selector(selectorId: string) {
    this.pruneSelectors();
    const cached = this.selectorCache.get(selectorId);
    if (!cached) throw new Error("Isolated browser selector expired; inspect the page again.");
    return cached;
  }
  private pruneSelectors() { const now = Date.now(); for (const [key, value] of this.selectorCache) if (value.expiresAt < now) this.selectorCache.delete(key); }

  private ensureLayout() {
    for (const path of [this.exchangeRoot, this.inbox, this.outbox, resolve(this.exchangeRoot, "screenshots"), resolve(this.exchangeRoot, "state")]) mkdirSync(path, { recursive: true });
  }
  private sandboxExecutable() {
    const path = "C:\\Windows\\System32\\WindowsSandbox.exe";
    return existsSync(path) ? path : null;
  }
  private nodeDirectory() {
    const candidates = [
      process.env.NHD_AGENT_NODE_DIR,
      process.env.ProgramFiles ? resolve(process.env.ProgramFiles, "nodejs") : "C:\\Program Files\\nodejs",
      basename(process.execPath).toLowerCase() === "node.exe" ? dirname(process.execPath) : "",
    ].filter(Boolean) as string[];
    return candidates.find((path) => existsSync(resolve(path, "node.exe"))) ?? null;
  }
  private readHeartbeat(): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(this.heartbeatPath, "utf8")) as Record<string, unknown>; } catch { return null; }
  }
}
