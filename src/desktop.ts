import { createHmac } from "node:crypto";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import type { TaskAuthorizationService, TaskCapabilityAction, TaskCapabilityLeaseView, TaskCapabilityUse } from "./task-authorization.js";

export type DesktopWindow = {
  windowId: string;
  title: string;
  processId: number;
  automationId: string;
  className: string;
  controlType: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

export type DesktopControl = {
  selectorId: string;
  windowId: string;
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  enabled: boolean;
  offscreen: boolean;
  password: boolean;
  depth: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

type DesktopRisk = {
  level: "low" | "moderate" | "high" | "blocked";
  category: TaskCapabilityAction | "safe_navigation" | "credentials";
  reason: string;
  capabilityRequired: boolean;
};

type DesktopApprovalProof = {
  version: "desktop-capability-v1"; leaseId: string; runId: string; app: string; category: TaskCapabilityAction;
  mode: "presence" | "consume"; windowId: string; selectorId: string; useId: string | null;
  expiresAt: string; issuedAt: string; signature: string;
};

const HARD_DENY = /\b(password|passcode|otp|cvv|cvc|card\s*number|credit\s*card|bank\s*account|routing\s*number|payment|pay\b|checkout|billing|transfer|wire|withdraw|purchase|buy\s*now|place\s*order|call|video\s*call|voice\s*call|credential|secret|api[_ -]?key|token)\b/i;
const MESSAGE_COMPOSE = /\b(message input|type a message|compose message|ask anything|chat input|prompt input|message box|soan tin|nhap tin nhan|noi dung tin nhan)\b/i;
const ACTION_RULES: Array<{ category: TaskCapabilityAction; level: "moderate" | "high"; test: RegExp }> = [
  { category: "delete", level: "high", test: /\b(delete|remove|trash|discard|erase)\b/i },
  { category: "upload", level: "high", test: /\b(upload|attach|choose\s*file|select\s*file)\b/i },
  { category: "download", level: "high", test: /\b(download|save\s+as)\b/i },
  { category: "login", level: "moderate", test: /\b(sign\s*in|log\s*in|login)\b/i },
  { category: "send", level: "moderate", test: /\b(send|message|gửi|gui)\b/i },
  { category: "submit", level: "moderate", test: /\b(submit|nộp|nop)\b/i },
  { category: "save", level: "moderate", test: /\b(save|lưu|luu)\b/i },
  { category: "publish", level: "moderate", test: /\b(publish)\b/i },
  { category: "post", level: "moderate", test: /\b(post)\b/i },
  { category: "reply", level: "moderate", test: /\b(reply)\b/i },
  { category: "comment", level: "moderate", test: /\b(comment)\b/i },
  { category: "confirm", level: "moderate", test: /\b(confirm|yes|ok\b)\b/i },
  { category: "apply", level: "moderate", test: /\b(apply)\b/i },
  { category: "register", level: "moderate", test: /\b(register|sign\s*up)\b/i },
  { category: "book", level: "moderate", test: /\b(book)\b/i },
  { category: "reserve", level: "moderate", test: /\b(reserve)\b/i },
  { category: "create", level: "moderate", test: /\b(create|new\b)\b/i },
];
export class DesktopService {
  private readonly controls = new Map<string, DesktopControl>();
  private readonly windowTitles = new Map<string, string>();

  constructor(readonly config: AppConfig, readonly store: Store, private readonly taskAuthorizations?: TaskAuthorizationService) {}

  private assertEnabled() {
    if (this.config.emergencyStop || !this.config.desktopEnabled) throw new Error("Desktop navigation is disabled by the owner.");
  }

  private async request(path: string, init: RequestInit = {}, timeout = 30_000) {
    const response = await fetch(`http://127.0.0.1:${this.config.screenPort}${path}`, {
      ...init,
      headers: { "x-workstation-companion-secret": this.config.companionSecret, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(body.error ?? response.statusText));
    return body;
  }

  async status() {
    if (!this.config.desktopEnabled) return { enabled: false, companion: false, windowCount: 0, safetyMode: "blocked" };
    try { return { enabled: true, companion: true, safetyMode: "approval-gated-host-desktop-v1", ...(await this.request("/ui/status", {}, 10_000)) }; }
    catch { return { enabled: true, companion: false, windowCount: 0, safetyMode: "approval-gated-host-desktop-v1" }; }
  }

  async windows(): Promise<{ windows: DesktopWindow[] }> {
    this.assertEnabled();
    const body = await this.request("/ui/windows");
    const windows = Array.isArray(body.windows) ? body.windows as DesktopWindow[] : [];
    for (const window of windows) this.windowTitles.set(String(window.windowId), String(window.title ?? ""));
    this.store.audit("desktop_windows", "success", { count: windows.length });
    return { windows };
  }

  async inspect(windowId: string, options: { query?: string; maxDepth?: number; limit?: number } = {}): Promise<{ windowId: string; controls: DesktopControl[]; total: number; truncated: boolean }> {
    this.assertEnabled();
    const body = await this.request("/ui/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowId, maxDepth: Math.min(Math.max(Math.trunc(options.maxDepth ?? 12), 1), 30), limit: Math.min(Math.max(Math.trunc(options.limit ?? 800), 20), 2000) }),
    }, 45_000);
    let controls = Array.isArray(body.controls) ? body.controls as DesktopControl[] : [];
    for (const control of controls) this.controls.set(String(control.selectorId), control);
    const query = options.query?.trim().toLocaleLowerCase("vi");
    if (query) controls = controls.filter((control) => `${control.name} ${control.automationId} ${control.className} ${control.controlType}`.toLocaleLowerCase("vi").includes(query));
    this.store.audit("desktop_inspect", "success", { windowId, query: query ?? null, returned: controls.length, total: Number(body.total ?? controls.length) });
    return { windowId, controls, total: Number(body.total ?? controls.length), truncated: Boolean(body.truncated) };
  }

  async action(input: { action: "activate" | "invoke" | "set_text" | "press_key" | "click_point" | "double_click_point" | "scroll" | "wait"; windowId?: string; selectorId?: string; text?: string; key?: string; xRatio?: number; yRatio?: number; direction?: "up" | "down"; amount?: number; milliseconds?: number; taskRunId?: string }) {
    this.assertEnabled();
    if (input.action === "wait") {
      const milliseconds = Math.min(Math.max(Math.trunc(input.milliseconds ?? 750), 100), 5000);
      await new Promise((resume) => setTimeout(resume, milliseconds));
      return { ok: true, action: "wait", milliseconds };
    }
    if (!input.taskRunId) throw new Error("Host desktop mutation requires a running durable task and task_run_id.");
    if (!this.taskAuthorizations?.allows(input.taskRunId, "moderate")) throw new Error("Host desktop mutation requires an active moderate-or-higher task authorization.");
    if (input.action === "click_point" || input.action === "double_click_point" || input.action === "scroll") {
      if (!input.windowId || !/^[0-9]+$/.test(input.windowId)) throw new Error("A valid windowId is required for visual navigation.");
      // A Flutter reader exposes an opaque pane. This is NOT permission to click arbitrary host desktop coordinates.
      const app = await this.resolveAppScope(input.windowId);
      if (app !== "NEU Reader") throw new Error("Host coordinate clicks remain blocked outside the verified NEU Reader window; other apps still require inspected selectors.");
      const xRatio = input.xRatio ?? 0.38;
      const yRatio = input.yRatio ?? 0.52;
      if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio < 0.12 || xRatio > 0.64 || yRatio < 0.16 || yRatio > 0.90)
        throw new Error("Reader visual navigation must target the bounded PDF content area, away from toolbar, download and assistant controls.");
      if (input.action === "double_click_point") throw new Error("Double clicks remain blocked for opaque Flutter controls.");
      if (input.action === "scroll" && ((input.direction !== "up" && input.direction !== "down") || !Number.isInteger(input.amount) || (input.amount ?? 0) < 1 || (input.amount ?? 0) > 6))
        throw new Error("Reader scroll requires direction up/down and 1-6 wheel units.");
      const payload = {action:input.action,windowId:input.windowId,xRatio,yRatio,...(input.action === "scroll" ? {direction:input.direction,amount:input.amount} : {})};
      const body = await this.request("/ui/action", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)},45000);
      if (body.ok !== true || body.hitTest === undefined) throw new Error("Reader visual navigation was not confirmed by companion hit-test; do not replay ambiguously.");
      this.store.audit("desktop_action","success",{action:input.action,windowId:input.windowId,taskRunId:input.taskRunId,app,category:"safe_reader_navigation",xRatio,yRatio,amount:input.action === "scroll" ? input.amount : null});
      return {...body,app,category:"safe_reader_navigation"};
    }
    if (input.action === "activate" || input.action === "press_key") {
      if (!input.windowId || !/^\d+$/.test(input.windowId)) throw new Error("A valid windowId is required for this desktop action.");
      const body = await this.request("/ui/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: input.action, windowId: input.windowId, key: input.key }) }, 45_000);
      this.store.audit("desktop_action", "success", { action: input.action, windowId: input.windowId, taskRunId: input.taskRunId, risk: "moderate", category: "safe_navigation" });
      return body;
    }
    if (input.action !== "invoke" && input.action !== "set_text") throw new Error("Unsupported host desktop action.");
    if (!input.selectorId) throw new Error("A short-lived selectorId is required for this desktop action.");
    const control = this.controls.get(input.selectorId);
    if (!control) throw new Error("Desktop selector is unknown to the authorization layer. Inspect the window again before acting.");
    const windowId = String(control.windowId || input.windowId || "");
    const app = await this.resolveAppScope(windowId);
    const risk = this.assessControl(control, input.action);
    if (risk.level === "blocked") throw new Error(`Host desktop action is platform-hard-denied: ${risk.reason}`);
    let approval: DesktopApprovalProof | null = null;
    let lease: TaskCapabilityLeaseView | null = null;
    let use: TaskCapabilityUse | null = null;
    if (risk.capabilityRequired) {
      const category = risk.category as TaskCapabilityAction;
      lease = this.taskAuthorizations.matchCapability(input.taskRunId, app, category);
      if (!lease) throw new Error(`Host desktop '${category}' action requires an active capability lease scoped to app '${app}'.`);
      if (risk.level === "high" && !this.taskAuthorizations.allows(input.taskRunId, "high")) throw new Error(`Host desktop high-risk '${category}' action requires high task authorization.`);
      if (input.action === "invoke") use = this.taskAuthorizations.consumeCapability(input.taskRunId, app, category);
      approval = this.signApproval({ lease: use ?? lease, useId: use?.useId ?? null, runId: input.taskRunId, app, category, mode: input.action === "invoke" ? "consume" : "presence", windowId, selectorId: input.selectorId });
    }
    const payload: Record<string, unknown> = { action: input.action, selectorId: input.selectorId };
    if (input.action === "set_text") payload.text = input.text ?? "";
    if (approval) payload.approval = approval;
    const body = await this.request("/ui/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, 45_000);
    this.store.audit("desktop_action", "success", { action: input.action, windowId, selectorId: input.selectorId, textLength: input.text?.length ?? 0, taskRunId: input.taskRunId, risk: risk.level, category: risk.category, app, capabilityLeaseId: lease?.id ?? null, capabilityUseId: use?.useId ?? null });
    return { ...body, risk, app, capabilityLease: lease ? { id: lease.id, remainingCount: use?.remainingCount ?? lease.remainingCount, expiresAt: lease.expiresAt } : null, capabilityUseId: use?.useId ?? null };
  }

  private assessControl(control: DesktopControl, action: "invoke" | "set_text"): DesktopRisk {
    const label = `${control.name ?? ""} ${control.automationId ?? ""} ${control.className ?? ""} ${control.controlType ?? ""}`.normalize("NFKC");
    if (control.password || HARD_DENY.test(label)) return { level: "blocked", category: "credentials", reason: "Credential/payment/transfer/purchase/call controls remain hard-denied.", capabilityRequired: false };
    if (action === "set_text") {
      if (MESSAGE_COMPOSE.test(label)) return { level: "moderate", category: "send", reason: "Message/prompt composition is allowed only inside a scoped send capability lease.", capabilityRequired: true };
      return { level: "low", category: "safe_navigation", reason: "Non-sensitive editable control.", capabilityRequired: false };
    }
    for (const rule of ACTION_RULES) if (rule.test.test(label)) return { level: rule.level, category: rule.category, reason: `The control can perform '${rule.category}' and requires a scoped capability lease.`, capabilityRequired: true };
    return { level: "low", category: "safe_navigation", reason: "Routine inspected control invocation.", capabilityRequired: false };
  }

  private async resolveAppScope(windowId: string) {
    let title = this.windowTitles.get(windowId);
    if (!title) {
      const body = await this.request("/ui/windows", {}, 10_000);
      const windows = Array.isArray(body.windows) ? body.windows as DesktopWindow[] : [];
      for (const window of windows) this.windowTitles.set(String(window.windowId), String(window.title ?? ""));
      title = this.windowTitles.get(windowId);
    }
    return String(title || `window:${windowId}`).normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  private signApproval(input: { lease: TaskCapabilityLeaseView; useId: string | null; runId: string; app: string; category: TaskCapabilityAction; mode: "presence" | "consume"; windowId: string; selectorId: string }): DesktopApprovalProof {
    const issuedAt = new Date().toISOString();
    const fields = ["desktop-capability-v1", input.lease.id, input.runId, input.app, input.category, input.mode, input.windowId, input.selectorId, input.useId ?? "", input.lease.expiresAt, issuedAt];
    const signature = createHmac("sha256", this.config.companionSecret).update(fields.join("\n"), "utf8").digest("hex");
    return { version: "desktop-capability-v1", leaseId: input.lease.id, runId: input.runId, app: input.app, category: input.category, mode: input.mode, windowId: input.windowId, selectorId: input.selectorId, useId: input.useId, expiresAt: input.lease.expiresAt, issuedAt, signature };
  }}





