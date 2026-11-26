import { assertPaymentAction, isPaymentAction } from "./payment-policy.js";
import { randomBytes } from "node:crypto";
import { Store } from "./db.js";
import { canonicalizeBrowserResource, createEphemeralOwnerId, resolveEphemeralOwnerId, resolveTaskRunId } from "./resource-guard.js";
import { HARD_DENY_CAPABILITIES, isHardDeniedCapability, TaskAuthorizationService, TaskCapabilityAction, TaskCapabilityLeaseView, TaskCapabilityUse } from "./task-authorization.js";

export type CocCocTabReport = {
  tabId: number;
  windowId: number | null;
  url: string;
  title: string;
  active: boolean;
  focused: boolean;
  visible: boolean;
  bridgeVersion: string;
  lastSeenAt: string;
  discarded?: boolean;
};

type CocCocControl = {
  selectorId: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  type: string;
  href: string;
  value: string;
  disabled: boolean;
  formAssociated: boolean;
  download: boolean;
  contentEditable: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
};

type SelectorCache = {
  tabId: number;
  expiresAt: number;
  meta: Omit<CocCocControl, "selectorId">;
};

type BridgeCommand = {
  id: string;
  tabId: number;
  type: "inspect" | "click" | "fill" | "edit_text" | "page_info" | "snapshot" | "scroll" | "focus" | "hover" | "select" | "press" | "wait_for" | "browser_command" | "screenshot";
  payload: Record<string, unknown>;
  createdAt: number;
  deliveredAt: number | null;
  expiresAt: number;
};

type BridgeResult = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type CocCocClickRiskLevel = "low" | "moderate" | "high" | "critical";
export type CocCocClickRisk = {
  level: CocCocClickRiskLevel;
  category: string;
  reason: string;
  taskAuthorizationRequired: boolean;
  capabilityAction?: TaskCapabilityAction;
  hardDenied?: boolean;
};

export type CocCocWaitCondition =
  | { kind: "url"; equals?: string; contains?: string }
  | { kind: "title"; equals?: string; contains?: string }
  | { kind: "text"; contains: string }
  | { kind: "value"; selectorId: string; equals: string }
  | { kind: "ready"; state?: "interactive" | "complete" }
  | { kind: "no-navigation"; url: string };

type CocCocTaskAuthorizer = Pick<TaskAuthorizationService, "active" | "allows">
  & Partial<Pick<TaskAuthorizationService, "matchCapability" | "consumeCapability" | "activeCapabilities" | "hasCapabilityHistory">>;

const TASK_SCOPED_ACTION_PATTERN = /\b(send|submit|save|publish|post|create|confirm|apply|register|book|reserve|reply|comment)\b/i;
const BLOCKED_FIELD_PATTERN = /\b(password|passcode|otp|cvv|cvc|card\s*number|credit\s*card|bank\s*account|routing\s*number|upload|attach)\b/i;
const HARD_DENY_ACTION_RULES: Array<{ category: string; test: RegExp }> = [
  { category: "credentials", test: /\b(password|passcode|otp|two[-\s]*factor|2fa|seed\s*phrase|private\s*key|secret\s*key|api\s*key)\b/i },
  { category: "payment", test: /\b(pay|payment|checkout|billing)\b/i },
  { category: "purchase", test: /\b(purchase|buy\s*now|place\s*order|order\s*now)\b/i },
  { category: "transfer", test: /\b(transfer|wire|withdraw|withdrawal)\b/i },
  { category: "call", test: /\b(call|video\s*call|voice\s*call)\b/i },
];
const HIGH_ACTION_RULES: Array<{ category: string; capabilityAction: TaskCapabilityAction; test: RegExp; objective: RegExp }> = [
  { category: "delete", capabilityAction: "delete", test: /\b(delete|remove|trash|discard|erase)\b/i, objective: /\b(delete|remove|trash|discard|erase|x[oó]a|gỡ|loại bỏ)\b/i },
  { category: "upload", capabilityAction: "upload", test: /\b(upload|attach|choose\s*file|select\s*file)\b/i, objective: /\b(upload|attach|tải\s*lên|đính\s*kèm|gửi\s*file)\b/i },
  { category: "authentication", capabilityAction: "login", test: /\b(sign\s*in|log\s*in|login|sign\s*out|log\s*out|logout)\b/i, objective: /\b(sign\s*in|log\s*in|login|sign\s*out|log\s*out|logout|đăng\s*nhập|đăng\s*xuất)\b/i },
];

function boundedString(value: unknown, max: number) {
  return String(value ?? "").slice(0, max);
}

export class CocCocBridgeService {
  private readonly tabs = new Map<number, CocCocTabReport>();
  private readonly syncedTabs = new Set<number>();
  private readonly nextWaiters = new Set<() => void>();
  private readonly commands = new Map<string, BridgeCommand>();
  private readonly waiters = new Map<string, { resolve: (value: BridgeResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly selectors = new Map<string, SelectorCache>();
  private readonly sensorSmokeTabs = new Set<number>();
  private readonly fallbackTabLocks = new Map<string, { taskRunId: string; expiresAt: number }>();

  constructor(readonly store: Store, private readonly taskAuthorizations?: CocCocTaskAuthorizer) {}

  private guardTabMutation(tabId: number | string, taskRunIdInput?: string, operation = "coc_coc_mutation") {
    const resource = canonicalizeBrowserResource("coccoc", tabId);
    const effectiveTaskRunId = resolveTaskRunId(taskRunIdInput);
    const callerEphemeralOwner = resolveEphemeralOwnerId();
    if (typeof (this.store as Store)?.guardResources === "function") {
      const guard = this.store.guardResources([resource], {
        mode: "write",
        taskRunId: effectiveTaskRunId,
        ephemeralOwnerId: effectiveTaskRunId ? undefined : callerEphemeralOwner,
        operation,
      });
      const ownsLocalEphemeral = !effectiveTaskRunId && !callerEphemeralOwner && Boolean(guard?.ephemeralOwnerId);
      return {
        releaseEphemeral: () => {
          if (ownsLocalEphemeral && guard?.ephemeralOwnerId && typeof this.store.releaseEphemeralOwnerResources === "function") {
            this.store.releaseEphemeralOwnerResources(guard.ephemeralOwnerId, `${operation}_completed`);
          }
        },
      };
    }
    // Fallback for lightweight unit-test mock stores that do not instantiate SQLite Store.
    const now = Date.now();
    const fallbackOwner = effectiveTaskRunId ?? callerEphemeralOwner ?? createEphemeralOwnerId("op");
    const ownsLocalFallback = !effectiveTaskRunId && !callerEphemeralOwner;
    const existing = this.fallbackTabLocks.get(resource);
    if (existing && existing.expiresAt > now && existing.taskRunId !== fallbackOwner) {
      throw new Error(`Resource is busy: ${resource} is locked by task ${existing.taskRunId} in background mode (write).`);
    }
    if (effectiveTaskRunId) {
      const row = this.taskRow(effectiveTaskRunId);
      if (!row || !["running", "waiting_confirmation"].includes(String(row.state ?? ""))) {
        throw new Error(`Task run '${effectiveTaskRunId}' is not an active running task.`);
      }
    }
    this.fallbackTabLocks.set(resource, { taskRunId: fallbackOwner, expiresAt: now + 600_000 });
    return {
      releaseEphemeral: () => {
        if (ownsLocalFallback) {
          const cur = this.fallbackTabLocks.get(resource);
          if (cur && cur.taskRunId === fallbackOwner) {
            this.fallbackTabLocks.delete(resource);
          }
        }
      },
    };
  }

  status() {
    this.prune();
    const tabs = this.listTabs();
    return {
      connected: tabs.length > 0,
      connectedTabs: tabs.length,
      activeTab: this.chooseTab(false),
      pendingCommands: [...this.commands.values()].filter((item) => !item.deliveredAt).length,
      bridge: "coc-coc-extension",
      safetyPolicy: "risk-based-task-scoped-v2",
      actionPolicy: {
        safeNavigation: "automatic",
        ordinaryCommit: "active moderate task authorization required (plus capability lease consumption when leased)",
        sensitiveAction: "active high task authorization plus explicit objective scope required",
        hardDeny: [...HARD_DENY_CAPABILITIES],
        sensitiveFields: "blocked",
        arbitraryScriptExecution: "blocked",
        comprehensiveBrowserControl: true,
      },
    };
  }

  listTabs() {
    this.prune();
    return [...this.tabs.values()].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });
  }

  // The extension inventory is authoritative for tabs it has reported.
  // Legacy pulse-only tabs are left alone until their normal expiry.
  syncTabs(input: Record<string, unknown>) {
    if (!Array.isArray(input.tabs)) throw new Error("Cốc Cốc sync-tabs requires a tabs array.");
    const current = new Set<number>();
    const now = new Date().toISOString();
    for (const value of input.tabs) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      const tabId = Number(item.tabId);
      const url = boundedString(item.url, 5000);
      if (!Number.isInteger(tabId) || tabId < 0 || !/^https?:\/\//i.test(url)) continue;
      const previous = this.tabs.get(tabId);
      if (previous && previous.url !== url) this.clearTabSelectors(tabId);
      current.add(tabId);
      this.tabs.set(tabId, {
        tabId, windowId: Number.isInteger(Number(item.windowId)) ? Number(item.windowId) : null,
        url, title: boundedString(item.title, 1000), active: Boolean(item.active),
        focused: previous?.focused === true && item.active === true,
        visible: Boolean(item.active), bridgeVersion: previous?.bridgeVersion ?? "",
        lastSeenAt: now, discarded: Boolean(item.discarded),
      });
    }
    for (const tabId of this.syncedTabs) if (!current.has(tabId)) this.closeTab(tabId);
    this.syncedTabs.clear();
    for (const tabId of current) this.syncedTabs.add(tabId);
    this.prune();
    return { ok: true, connectedTabs: this.tabs.size };
  }

  private takeNextCommands() {
    this.prune();
    const now = Date.now();
    return [...this.commands.values()]
      .filter(item => item.expiresAt > now && item.deliveredAt == null)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 4)
      .map(item => {
        item.deliveredAt = now;
        return { id: item.id, tabId: item.tabId, type: item.type, payload: item.payload, expiresAt: item.expiresAt };
      });
  }

  nextCommands(input: Record<string, unknown> = {}) {
    const requested = Number(input.timeoutMs ?? 25_000);
    const timeout = Number.isFinite(requested) ? Math.max(0, Math.min(25_000, requested)) : 25_000;
    const commands = this.takeNextCommands();
    if (commands.length || timeout === 0) return Promise.resolve({ commands });
    return new Promise<{ commands: ReturnType<CocCocBridgeService["takeNextCommands"]> }>(resolve => {
      const wake = () => {
        const available = this.takeNextCommands();
        if (available.length) {
          clearTimeout(timer);
          this.nextWaiters.delete(wake);
          resolve({ commands: available });
        }
      };
      const timer = setTimeout(() => {
        this.nextWaiters.delete(wake);
        resolve({ commands: [] });
      }, timeout);
      this.nextWaiters.add(wake);
    });
  }

  private timeoutError(command: BridgeCommand | undefined, message: string) {
    const code = command && this.tabs.get(command.tabId)?.discarded ? "tab_sleeping"
      : command?.deliveredAt != null ? "page_slow" : "bridge_missing";
    return new Error(`${code}: ${message}`);
  }

  pulse(input: Record<string, unknown>) {
    const tabId = Number(input.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Cốc Cốc bridge pulse requires a valid tabId.");
    const report: CocCocTabReport = {
      tabId,
      windowId: Number.isInteger(Number(input.windowId)) ? Number(input.windowId) : null,
      url: boundedString(input.url, 5000),
      title: boundedString(input.title, 1000),
      active: Boolean(input.active),
      focused: Boolean(input.focused),
      visible: input.visible !== false,
      bridgeVersion: boundedString(input.bridgeVersion, 100),
      lastSeenAt: new Date().toISOString(),
      discarded: false,
    };
    if (!/^https?:\/\//i.test(report.url)) throw new Error("Cốc Cốc DOM bridge accepts HTTP/HTTPS pages only.");
    this.tabs.set(tabId, report);
    this.prune();
    const now = Date.now();
    const commands = [...this.commands.values()]
      .filter((item) => item.tabId === tabId && item.expiresAt > now && item.deliveredAt == null)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 4)
      .map((item) => {
        item.deliveredAt = now;
        return { id: item.id, type: item.type, payload: item.payload, expiresAt: item.expiresAt };
      });
    return { ok: true, commands };
  }

  closeTab(tabIdInput: unknown) {
    const tabId = Number(tabIdInput);
    if (!Number.isInteger(tabId)) return { ok: false };
    this.tabs.delete(tabId);
    this.syncedTabs.delete(tabId);
    this.sensorSmokeTabs.delete(tabId);
    for (const [key, selector] of this.selectors) if (selector.tabId === tabId) this.selectors.delete(key);
    for (const command of this.commands.values()) {
      if (command.tabId !== tabId) continue;
      const waiter = this.waiters.get(command.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("bridge_missing: Cốc Cốc tab closed before the DOM command completed."));
        this.waiters.delete(command.id);
      }
      this.commands.delete(command.id);
    }
    return { ok: true };
  }

  resolveResult(input: Record<string, unknown>) {
    const id = boundedString(input.id, 200);
    const command = this.commands.get(id);
    if (!command) return { ok: false, ignored: true };
    const waiter = this.waiters.get(id);
    const bridgeResult: BridgeResult = {
      id,
      ok: input.ok === true,
      result: input.result,
      error: input.ok === true ? undefined : (() => {
        const message = boundedString(input.error || "Cốc Cốc DOM command failed.", 2000);
        return /^(tab_sleeping|bridge_missing|page_slow):/.test(message) ? message : `page_slow: ${message}`;
      })(),
    };
    this.commands.delete(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve(bridgeResult);
    }
    return { ok: true };
  }

  async inspect(query = "", limit = 200, tabId?: number) {
    const tab = this.chooseSpecificTab(tabId);
    const response = await this.issue(tab.tabId, "inspect", { query: query.slice(0, 500), limit: Math.max(1, Math.min(limit, 500)) }, 8000);
    if (!response.ok) throw new Error(response.error || "Cốc Cốc DOM inspection failed.");
    const raw = response.result as { page?: Record<string, unknown>; controls?: Array<Record<string, unknown>>; total?: number; truncated?: boolean } | undefined;
    const controls = Array.isArray(raw?.controls) ? raw!.controls! : [];
    const expiresAt = Date.now() + 5 * 60_000;
    const normalized: CocCocControl[] = controls.slice(0, Math.max(1, Math.min(limit, 500))).map((item) => {
      const selectorId = boundedString(item.selectorId, 200);
      if (!selectorId) throw new Error("Cốc Cốc DOM bridge returned an invalid selector.");
      const meta: Omit<CocCocControl, "selectorId"> = {
        tag: boundedString(item.tag, 60), role: boundedString(item.role, 100), name: boundedString(item.name, 300), text: boundedString(item.text, 500),
        type: boundedString(item.type, 100), href: boundedString(item.href, 5000), value: boundedString(item.value, 500), disabled: Boolean(item.disabled),
        formAssociated: Boolean(item.formAssociated), download: Boolean(item.download), contentEditable: Boolean(item.contentEditable), bounds: item.bounds && typeof item.bounds === "object" ? item.bounds as CocCocControl["bounds"] : null,
      };
      this.selectors.set(selectorId, { tabId: tab.tabId, expiresAt, meta });
      return { selectorId, ...meta };
    });
    this.prune();
    this.store.audit("coc_coc_inspect", "success", { tabId: tab.tabId, url: tab.url, returned: normalized.length, query: query.slice(0, 200) });
    return { page: raw?.page ?? { title: tab.title, url: tab.url }, controls: normalized, total: Number(raw?.total ?? normalized.length), truncated: Boolean(raw?.truncated) };
  }

  assessClick(selectorId: string): CocCocClickRisk {
    const cached = this.resolveSelector(selectorId);
    return this.assessClickMeta(cached.meta);
  }

  async click(selectorId: string, taskRunId?: string) {
    const cached = this.resolveSelector(selectorId);
    if (cached.meta.disabled) throw new Error("Cốc Cốc control is disabled.");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId);
    const risk = this.assessClickMeta(cached.meta);
    const authorization = this.requireAuthorization(risk, effectiveTaskRunId);
    const tabGuard = this.guardTabMutation(cached.tabId, effectiveTaskRunId, "coc_coc_click");
    try {
      const capabilityUse = this.consumeTabCapabilityIfApplicable(cached.tabId, risk, effectiveTaskRunId);
      const response = await this.issue(cached.tabId, "click", { selectorId }, 8000);
      if (!response.ok) throw new Error(response.error || "Cốc Cốc click failed.");
      this.clearTabSelectors(cached.tabId);
      this.store.audit("coc_coc_click", "success", {
        tabId: cached.tabId,
        selectorId,
        risk,
        taskRunId: effectiveTaskRunId ?? null,
        taskAuthorizationId: authorization?.id ?? null,
        capabilityLeaseId: capabilityUse?.id ?? null,
        capabilityUseId: capabilityUse?.useId ?? null,
        control: { tag: cached.meta.tag, role: cached.meta.role, name: cached.meta.name, text: cached.meta.text.slice(0, 200) },
      });
      const result = response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : { ok: true };
      return {
        ...result,
        risk,
        taskAuthorization: authorization ? { id: authorization.id, runId: authorization.runId, maxRiskLevel: authorization.maxRiskLevel, expiresAt: authorization.expiresAt } : null,
        ...(capabilityUse ? {
          capabilityLease: {
            id: capabilityUse.id,
            runId: capabilityUse.runId,
            appScope: capabilityUse.appScope,
            actions: capabilityUse.actions,
            maxCount: capabilityUse.maxCount,
            usedCount: capabilityUse.usedCount,
            remainingCount: capabilityUse.remainingCount,
            expiresAt: capabilityUse.expiresAt,
          },
          capabilityUseId: capabilityUse.useId,
        } : {}),
      };
    } finally {
      tabGuard.releaseEphemeral();
    }
  }

  async fill(selectorId: string, text: string, taskRunId?: string) {
    if (text.length > 500) throw new Error("Cốc Cốc fill text is limited to 500 characters.");
    const cached = this.resolveSelector(selectorId);
    const description = `${cached.meta.type} ${cached.meta.name} ${cached.meta.text}`;
    assertPaymentAction(description);
    if (cached.meta.type === "password" || cached.meta.type === "file" || BLOCKED_FIELD_PATTERN.test(description)) throw new Error("Sensitive Cốc Cốc field is blocked.");
    const tabUrl = this.tabs.get(cached.tabId)?.url ?? "";
    const canvaSemanticText = /^https:\/\/(?:[^/]+\.)?canva\.com\//i.test(tabUrl) && cached.meta.role === "group" && Boolean(cached.meta.text || cached.meta.name);
    const semanticText = cached.meta.contentEditable || canvaSemanticText;
    if (!(["input", "textarea", "select"].includes(cached.meta.tag) || cached.meta.role === "textbox" || semanticText)) throw new Error("Cốc Cốc fill is limited to editable text controls (plus semantic Canva text elements).");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId);
    const capabilityPresence = this.checkTabComposeCapabilityIfApplicable(cached.tabId, effectiveTaskRunId);
    const tabGuard = this.guardTabMutation(cached.tabId, effectiveTaskRunId, "coc_coc_fill");
    try {
      const response = await this.issue(cached.tabId, semanticText ? "edit_text" : "fill", { selectorId, text }, 8000);
      if (!response.ok) throw new Error(response.error || "Cốc Cốc fill failed.");
      this.store.audit("coc_coc_fill", "success", {
        tabId: cached.tabId,
        selectorId,
        characters: text.length,
        taskRunId: effectiveTaskRunId ?? null,
        capabilityLeaseId: capabilityPresence?.id ?? null,
        control: { tag: cached.meta.tag, name: cached.meta.name },
        semantic: semanticText,
      });
      const baseResult = response.result && typeof response.result === "object"
        ? response.result as Record<string, unknown>
        : { ok: true, selectorId, characters: text.length };
      if (semanticText && baseResult.verified !== true) throw new Error("Cốc Cốc semantic text edit executed exactly once but exact text verification failed; it was not replayed.");
      return capabilityPresence
        ? {
            ...baseResult,
            capabilityLease: {
              id: capabilityPresence.id,
              runId: capabilityPresence.runId,
              appScope: capabilityPresence.appScope,
              actions: capabilityPresence.actions,
              maxCount: capabilityPresence.maxCount,
              usedCount: capabilityPresence.usedCount,
              remainingCount: capabilityPresence.remainingCount,
              expiresAt: capabilityPresence.expiresAt,
            },
            capabilityMode: "presence",
          }
        : baseResult;
    } finally {
      tabGuard.releaseEphemeral();
    }
  }

  async editText(selectorId: string, text: string, taskRunId?: string) {
    if (text.length > 2000) throw new Error("Cốc Cốc semantic text edit is limited to 2000 characters.");
    const cached = this.resolveSelector(selectorId);
    const tabUrl = this.tabs.get(cached.tabId)?.url ?? "";
    const allowed = cached.meta.contentEditable || (/^https:\/\/(?:[^/]+\.)?canva\.com\//i.test(tabUrl) && cached.meta.role === "group" && Boolean(cached.meta.text || cached.meta.name));
    if (!allowed) throw new Error("Semantic text edit requires a contenteditable control or a semantic Canva text element.");
    const effectiveTaskRunId = resolveTaskRunId(taskRunId);
    const tabGuard = this.guardTabMutation(cached.tabId, effectiveTaskRunId, "coc_coc_edit_text");
    try {
      const response = await this.issue(cached.tabId, "edit_text", { selectorId, text }, 10000);
      if (!response.ok) throw new Error(response.error || "Cốc Cốc semantic text edit failed.");
      const result = response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : {};
      if (result.verified !== true) throw new Error("Cốc Cốc semantic text edit executed exactly once but exact text verification failed; it was not replayed.");
      this.store.audit("coc_coc_edit_text", "success", { tabId: cached.tabId, selectorId, characters: text.length, taskRunId: effectiveTaskRunId ?? null, strategy: result.strategy ?? null });
      return result;
    } finally { tabGuard.releaseEphemeral(); }
  }

  async pageInfo(tabId?: number) {
    const tab = this.chooseSpecificTab(tabId);
    const response = await this.issue(tab.tabId, "page_info", {}, 5000);
    if (!response.ok) throw new Error(response.error || "Cốc Cốc page inspection failed.");
    return response.result;
  }

  async snapshot(tabId?: number, maxChars = 50_000) {
    const tab = this.chooseSpecificTab(tabId);
    const boundedMax = Math.max(1_000, Math.min(maxChars, 100_000));
    const response = await this.issue(tab.tabId, "snapshot", { maxChars: boundedMax }, 10_000);
    if (!response.ok) throw new Error(response.error || "Cốc Cốc page snapshot failed.");
    this.store.audit("coc_coc_snapshot", "success", { tabId: tab.tabId, url: tab.url, maxChars: boundedMax });
    return response.result;
  }

  async action(input: {
    action: "scroll" | "focus" | "hover" | "select" | "press";
    selectorId?: string;
    tabId?: number;
    deltaX?: number;
    deltaY?: number;
    value?: string;
    key?: string;
    taskRunId?: string;
  }) {
    const selector = input.selectorId ? this.resolveSelector(input.selectorId) : null;
    const tab = selector ? this.chooseSpecificTab(selector.tabId) : this.chooseSpecificTab(input.tabId);
    if (selector) assertPaymentAction(`${selector.meta.type} ${selector.meta.name} ${selector.meta.text} ${selector.meta.href}`);
    if (selector && selector.tabId !== tab.tabId) throw new Error("Cốc Cốc selector belongs to a different tab.");
    if (input.action === "focus" || input.action === "hover") {
      if (!selector) throw new Error(`selector_id is required for ${input.action}.`);
    }
    if (input.action === "select") {
      if (!selector) throw new Error("selector_id is required for select.");
      const description = `${selector.meta.type} ${selector.meta.name} ${selector.meta.text}`;
      if (BLOCKED_FIELD_PATTERN.test(description)) throw new Error("Sensitive Cốc Cốc field is blocked.");
      if (selector.meta.tag !== "select" && selector.meta.role !== "combobox") throw new Error("Cốc Cốc select requires a select/combobox control.");
    }
    let risk: CocCocClickRisk = { level: "low", category: "safe_navigation", reason: "Routine browser navigation/control action.", taskAuthorizationRequired: false };
    const key = String(input.key ?? "").toUpperCase();
    if (input.action === "press" && ["ENTER"].includes(key)) {
      risk = { level: "moderate", category: "ordinary_commit", reason: "Enter can submit or commit the focused form and therefore requires task scope.", taskAuthorizationRequired: true };
    }
    const effectiveTaskRunId = resolveTaskRunId(input.taskRunId);
    const authorization = this.requireAuthorization(risk, effectiveTaskRunId);
    const tabGuard = this.guardTabMutation(tab.tabId, effectiveTaskRunId, `coc_coc_action_${input.action}`);
    try {
      const payload: Record<string, unknown> = { action: input.action };
      if (input.selectorId) payload.selectorId = input.selectorId;
      if (input.deltaX != null) payload.deltaX = Math.max(-20_000, Math.min(20_000, Number(input.deltaX)));
      if (input.deltaY != null) payload.deltaY = Math.max(-20_000, Math.min(20_000, Number(input.deltaY)));
      if (input.value != null) payload.value = String(input.value).slice(0, 1000);
      if (input.key != null) payload.key = key.slice(0, 40);
      const response = await this.issue(tab.tabId, input.action, payload, 8_000);
      if (!response.ok) throw new Error(response.error || `Cốc Cốc ${input.action} failed.`);
      if (["select", "press"].includes(input.action)) this.clearTabSelectors(tab.tabId);
      this.store.audit("coc_coc_action", "success", { tabId: tab.tabId, action: input.action, selectorId: input.selectorId ?? null, risk, taskRunId: effectiveTaskRunId ?? null, taskAuthorizationId: authorization?.id ?? null });
      return { ...(response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : { ok: true }), risk };
    } finally {
      tabGuard.releaseEphemeral();
    }
  }

  async waitFor(condition: CocCocWaitCondition, tabId?: number, timeoutMs = 5_000) {
    const tab = this.chooseSpecificTab(tabId);
    const timeout = Math.max(100, Math.min(timeoutMs, 15_000));
    const response = await this.issue(tab.tabId, "wait_for", { condition, timeoutMs: timeout }, timeout + 1_500);
    if (!response.ok) throw new Error(response.error || "Cốc Cốc wait condition failed.");
    this.store.audit("coc_coc_wait_for", "success", { tabId: tab.tabId, kind: condition.kind, timeoutMs: timeout });
    return response.result;
  }

  async clickVerified(selectorId: string, condition: Exclude<CocCocWaitCondition, { kind: "value" }>, taskRunId?: string, timeoutMs = 5_000) {
    const before = this.resolveSelector(selectorId);
    const tabId = before.tabId;
    const action = await this.click(selectorId, taskRunId);
    try {
      const verification = await this.waitFor(condition, tabId, timeoutMs);
      return { ok: true, action, verification, replayed: false };
    } catch (error) {
      throw new Error(`Cốc Cốc click executed exactly once, but post-condition verification was ambiguous/failed; the click was not replayed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async fillVerified(selectorId: string, text: string, timeoutMs = 5_000, taskRunId?: string) {
    const cached = this.resolveSelector(selectorId);
    const tabId = cached.tabId;
    const action = await this.fill(selectorId, text, taskRunId);
    try {
      if ((action as Record<string, unknown>).semantic === true) {
        if ((action as Record<string, unknown>).verified !== true) throw new Error("semantic bridge verification was false");
        return { ok: true, selectorId, characters: text.length, verification: { kind: "semantic_text", exact: true }, replayed: false, actionVerified: true };
      }
      const verification = await this.waitFor({ kind: "value", selectorId, equals: text }, tabId, timeoutMs);
      return { ok: true, selectorId, characters: text.length, verification, replayed: false, actionVerified: true };
    } catch (error) {
      throw new Error(`Cốc Cốc fill executed exactly once, but exact value verification failed; the fill was not replayed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async openChatHealthSmoke(urlInput:string) {
    const url=new URL(String(urlInput));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "chatgpt.com") throw new Error("Chat Health smoke tab must target https://chatgpt.com only.");
    const response = await this.issueTransport("browser_command", { action:"create_tab", url:url.toString(), active:false }, 10_000);
    if (!response.ok) throw new Error(response.error || "Failed to create Chat Health smoke tab.");
    const raw=response.result && typeof response.result === "object" ? response.result as Record<string,unknown> : {};
    const tab=(raw.tab && typeof raw.tab === "object" ? raw.tab : null) as Record<string,unknown>|null;
    const tabId=Number(tab?.tabId);
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Chat Health smoke tab creation returned no valid tab id.");
    this.sensorSmokeTabs.add(tabId);
    this.store.audit("chat_health_sensor_smoke","opened",{tabId,url:url.toString(),active:false});
    return {ok:true,tabId,url:url.toString(),active:false,ownedSmokeTab:true};
  }

  async closeChatHealthSmoke(tabIdInput:number) {
    const tabId=Number(tabIdInput);
    if (!Number.isInteger(tabId) || !this.sensorSmokeTabs.has(tabId)) throw new Error("Only a Chat Health smoke tab created by this runtime may be closed through this route.");
    const response=await this.issueTransport("browser_command",{action:"close_tab",tabId},8_000);
    if (!response.ok) throw new Error(response.error || "Failed to close Chat Health smoke tab.");
    this.sensorSmokeTabs.delete(tabId);
    this.store.audit("chat_health_sensor_smoke","closed",{tabId});
    return {ok:true,tabId,closed:true,ownedSmokeTab:true};
  }

  async browserTabs() {
    const response = await this.issueTransport("browser_command", { action: "list_tabs" }, 6_000);
    if (!response.ok) throw new Error(response.error || "Cốc Cốc tab listing failed.");
    return response.result;
  }

  async tabAction(input: { action: "list" | "open" | "activate" | "navigate" | "reload" | "back" | "forward" | "close"; tabId?: number; url?: string; active?: boolean; taskRunId?: string }) {
    if (input.action === "list") return this.browserTabs();
    if (["open", "navigate"].includes(input.action)) assertPaymentAction(input.url);
    if (["open", "navigate"].includes(input.action)) {
      if (!input.url || !/^https?:\/\//i.test(input.url)) throw new Error("Cốc Cốc tab URL must be explicit HTTP/HTTPS.");
    }
    if (input.action !== "open" && !Number.isInteger(input.tabId)) throw new Error(`tab_id is required for ${input.action}.`);
    let risk: CocCocClickRisk = { level: "low", category: "safe_navigation", reason: "Routine tab activation/open action.", taskAuthorizationRequired: false };
    if (["navigate", "reload", "back", "forward", "close"].includes(input.action)) {
      risk = { level: "moderate", category: "tab_state_change", reason: "Changing or closing an existing tab can discard unsaved page state and requires task scope.", taskAuthorizationRequired: true };
    }
    const effectiveTaskRunId = resolveTaskRunId(input.taskRunId);
    const authorization = this.requireAuthorization(risk, effectiveTaskRunId);
    let tabGuard: { releaseEphemeral: () => void } | null = null;
    if (input.action !== "open" && Number.isInteger(input.tabId)) {
      tabGuard = this.guardTabMutation(Number(input.tabId), effectiveTaskRunId, `coc_coc_tab_${input.action}`);
    } else if (input.action === "open") {
      tabGuard = this.guardTabMutation("new", effectiveTaskRunId, "coc_coc_tab_open");
    }
    try {
      const actionMap: Record<string, string> = { open: "create_tab", activate: "activate_tab", navigate: "navigate_tab", reload: "reload_tab", back: "back_tab", forward: "forward_tab", close: "close_tab" };
      const response = await this.issueTransport("browser_command", { action: actionMap[input.action], tabId: input.tabId, url: input.url, active: input.active === true }, 10_000);
      if (!response.ok) throw new Error(response.error || `Cốc Cốc tab ${input.action} failed.`);
      this.store.audit("coc_coc_tab", "success", { action: input.action, tabId: input.tabId ?? null, risk, taskRunId: effectiveTaskRunId ?? null, taskAuthorizationId: authorization?.id ?? null });
      return { ...(response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : { ok: true }), risk };
    } finally {
      tabGuard?.releaseEphemeral();
    }
  }

  async screenshot(tabId?: number) {
    const response = await this.issueTransport("screenshot", { tabId }, 12_000);
    if (!response.ok) throw new Error(response.error || "Cốc Cốc screenshot failed.");
    const raw = response.result as Record<string, unknown> | undefined;
    const dataUrl = boundedString(raw?.dataUrl, 8_000_000);
    const match = dataUrl.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/s);
    if (!match) throw new Error("Cốc Cốc screenshot returned invalid image data.");
    return { page: raw?.page ?? null, tab: raw?.tab ?? null, mimeType: match[1], data: match[2] };
  }

  private issueTransport(type: BridgeCommand["type"], payload: Record<string, unknown>, timeoutMs: number) {
    const transport = this.chooseTab(true);
    if (!transport) throw new Error("bridge_missing: No fresh Cốc Cốc extension transport tab is connected.");
    return this.issue(transport.tabId, type, payload, timeoutMs);
  }

  private assessClickMeta(meta: Omit<CocCocControl, "selectorId">): CocCocClickRisk {
    const description = `${meta.role} ${meta.name} ${meta.text} ${meta.href}`;
    if (isPaymentAction(description)) return { level: "high", category: "payment", reason: "PAYMENT_BLOCKED: payment action is platform-hard-denied.", taskAuthorizationRequired: true, hardDenied: true };
    if (/^javascript:/i.test(meta.href)) return { level: "critical", category: "script_protocol", reason: "Script-protocol navigation is never allowed.", taskAuthorizationRequired: true, hardDenied: true };
    if (/^tel:/i.test(meta.href)) return { level: "high", category: "call", reason: "Phone/voice call protocol is platform-hard-denied.", taskAuthorizationRequired: true, hardDenied: true };
    if (/^(?:mailto|sms):/i.test(meta.href)) return { level: "high", category: "external_protocol", capabilityAction: "external_protocol", reason: "External communication protocol requires explicit high-risk task scope.", taskAuthorizationRequired: true };
    if (meta.type === "password") return { level: "critical", category: "credentials", reason: "Credential controls are platform-hard-denied.", taskAuthorizationRequired: true, hardDenied: true };
    if (meta.type === "file") return { level: "high", category: "upload", capabilityAction: "upload", reason: "File-picker/upload controls require explicit high-risk task scope.", taskAuthorizationRequired: true };
    if (meta.download) return { level: "high", category: "download", capabilityAction: "download", reason: "Downloads require explicit high-risk task scope.", taskAuthorizationRequired: true };
    for (const hardRule of HARD_DENY_ACTION_RULES) {
      if (hardRule.test.test(description)) {
        return {
          level: "high",
          category: hardRule.category,
          reason: `Hard-denied '${hardRule.category}' action is blocked by workstation safety policy.`,
          taskAuthorizationRequired: true,
          hardDenied: true,
        };
      }
    }
    for (const rule of HIGH_ACTION_RULES) {
      if (rule.test.test(description)) {
        return {
          level: "high",
          category: rule.category,
          capabilityAction: rule.capabilityAction,
          reason: `Sensitive '${rule.category}' action requires explicit high-risk task scope.`,
          taskAuthorizationRequired: true,
        };
      }
    }
    const commitMatch = description.match(TASK_SCOPED_ACTION_PATTERN);
    if ((meta.formAssociated && (meta.type === "submit" || meta.type === "image")) || commitMatch) {
      const matchedVerb = (commitMatch?.[1]?.toLowerCase() ?? "submit") as TaskCapabilityAction;
      return {
        level: "moderate",
        category: "ordinary_commit",
        capabilityAction: matchedVerb,
        reason: "Ordinary workflow commit requires an active task-scoped authorization.",
        taskAuthorizationRequired: true,
      };
    }
    return { level: "low", category: "safe_navigation", reason: "Routine navigation/control action.", taskAuthorizationRequired: false };
  }

  private requireAuthorization(risk: CocCocClickRisk, taskRunId?: string) {
    if (risk.level === "low") return null;
    if (risk.level === "critical") throw new Error(`Cốc Cốc action is blocked by workstation safety policy: ${risk.reason}`);
    if (risk.hardDenied || isHardDeniedCapability(risk.category)) {
      if (risk.reason.startsWith("PAYMENT_BLOCKED")) throw new Error("PAYMENT_BLOCKED: payment action is platform-hard-denied and outside the durable task objective; it remains blocked.");
      throw new Error(`Cốc Cốc high-risk '${risk.category}' action is platform-hard-denied and outside the durable task objective; it remains blocked.`);
    }
    if (!taskRunId || !this.taskAuthorizations) {
      throw new Error(`Cốc Cốc ${risk.level}-risk action requires an active task-scoped authorization; retry with task_run_id after authorizing the durable task.`);
    }
    const run = this.taskRow(taskRunId);
    if (!run || String(run.state) !== "running") throw new Error("Cốc Cốc task-scoped action requires a currently running durable task.");
    if (!this.taskAuthorizations.allows(taskRunId, risk.level)) {
      throw new Error(`Cốc Cốc ${risk.level}-risk action is not covered by the active task authorization.`);
    }
    if (risk.level === "high" && !this.objectiveAllowsHighRisk(String(run.objective ?? ""), risk.category)) {
      throw new Error(`Cốc Cốc high-risk '${risk.category}' action is outside the durable task objective and remains blocked.`);
    }
    return this.taskAuthorizations.active(taskRunId);
  }

  private tabScopeCandidates(tabId: number): string[] {
    const tab = this.tabs.get(tabId);
    const candidates: string[] = [];
    if (tab?.title) candidates.push(tab.title);
    if (tab?.url) {
      candidates.push(tab.url);
      try {
        const host = new URL(tab.url).hostname.toLowerCase().replace(/^www\./, "");
        if (host) {
          candidates.push(`domain:${host}`);
          candidates.push(host);
        }
      } catch {}
    }
    candidates.push("CocCoc", "Cốc Cốc");
    return [...new Set(candidates.filter(Boolean))];
  }

  private consumeTabCapabilityIfApplicable(tabId: number, risk: CocCocClickRisk, taskRunId?: string): TaskCapabilityUse | null {
    if (!taskRunId || !risk.capabilityAction) return null;
    if (!this.taskAuthorizations?.activeCapabilities || !this.taskAuthorizations?.matchCapability || !this.taskAuthorizations?.consumeCapability) {
      return null;
    }
    const activeLeases = this.taskAuthorizations.activeCapabilities(taskRunId);
    const hasHistory = this.taskAuthorizations.hasCapabilityHistory ? this.taskAuthorizations.hasCapabilityHistory(taskRunId) : activeLeases.length > 0;
    if (!activeLeases.length && !hasHistory) return null;
    const candidates = this.tabScopeCandidates(tabId);
    const actionCandidates: TaskCapabilityAction[] = risk.capabilityAction === "submit"
      ? ["submit", "send"]
      : risk.capabilityAction === "send"
      ? ["send", "submit"]
      : [risk.capabilityAction];
    for (const candidateScope of candidates) {
      for (const action of actionCandidates) {
        if (this.taskAuthorizations.matchCapability(taskRunId, candidateScope, action)) {
          return this.taskAuthorizations.consumeCapability(taskRunId, candidateScope, action);
        }
      }
    }
    const tab = this.tabs.get(tabId);
    const label = tab?.title || tab?.url || `tab:${tabId}`;
    throw new Error(`No active capability lease covers '${risk.capabilityAction}' for Cốc Cốc tab '${label}' (requires an active capability lease scoped to '${label}').`);
  }

  private checkTabComposeCapabilityIfApplicable(tabId: number, taskRunId?: string): TaskCapabilityLeaseView | null {
    if (!taskRunId || !this.taskAuthorizations?.activeCapabilities || !this.taskAuthorizations?.matchCapability) {
      return null;
    }
    const activeLeases = this.taskAuthorizations.activeCapabilities(taskRunId);
    const hasHistory = this.taskAuthorizations.hasCapabilityHistory ? this.taskAuthorizations.hasCapabilityHistory(taskRunId) : activeLeases.length > 0;
    if (!activeLeases.length && !hasHistory) return null;
    const candidates = this.tabScopeCandidates(tabId);
    const composeActions: TaskCapabilityAction[] = ["send", "submit", "reply", "comment", "post"];
    for (const candidateScope of candidates) {
      for (const action of composeActions) {
        const matched = this.taskAuthorizations.matchCapability(taskRunId, candidateScope, action);
        if (matched) return matched;
      }
    }
    const tab = this.tabs.get(tabId);
    const label = tab?.title || tab?.url || `tab:${tabId}`;
    throw new Error(`No active capability lease covers compose fill for Cốc Cốc tab '${label}' (requires an active capability lease scoped to '${label}').`);
  }

  private taskRow(taskRunId: string): Record<string, unknown> | null {
    const db = (this.store as Store & { db?: { prepare?: (sql: string) => { get?: (...args: unknown[]) => unknown } } }).db;
    if (!db?.prepare) return null;
    const row = db.prepare("SELECT id,objective,state FROM agent_runs WHERE id=?").get?.(taskRunId);
    return row && typeof row === "object" ? row as Record<string, unknown> : null;
  }

  private objectiveAllowsHighRisk(objective: string, category: string) {
    if (category === "download") return /\b(download|tải\s*xuống|tải\s*về)\b/i.test(objective);
    if (category === "external_protocol") return /\b(call|message|email|sms|gọi|nhắn|gửi\s*mail|gửi\s*email)\b/i.test(objective);
    const rule = HIGH_ACTION_RULES.find((item) => item.category === category);
    return Boolean(rule?.objective.test(objective));
  }

  private issue(tabId: number, type: BridgeCommand["type"], payload: Record<string, unknown>, timeoutMs: number): Promise<BridgeResult> {
    this.prune();
    if (!this.tabs.has(tabId)) throw new Error("bridge_missing: Cốc Cốc tab is not connected to the DOM bridge.");
    const id = `coc-${randomBytes(12).toString("hex")}`;
    const now = Date.now();
    const command: BridgeCommand = { id, tabId, type, payload, createdAt: now, deliveredAt: null, expiresAt: now + Math.max(1000, timeoutMs) };
    this.commands.set(id, command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commands.delete(id);
        this.waiters.delete(id);
        reject(this.timeoutError(command, "Cốc Cốc extension did not return the DOM command before timeout. Make sure the tab is open and the extension is enabled."));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      for (const wake of this.nextWaiters) wake();
    });
  }

  private chooseSpecificTab(tabId?: number) {
    this.prune();
    if (Number.isInteger(tabId)) {
      const tab = this.tabs.get(Number(tabId));
      if (!tab) throw new Error(`bridge_missing: Cốc Cốc tab ${tabId} is not connected.`);
      return tab;
    }
    const tab = this.chooseTab(true);
    if (!tab) throw new Error("bridge_missing: No Cốc Cốc tab is currently connected to the NHD DOM bridge.");
    return tab;
  }

  private chooseTab(requireFresh: boolean): CocCocTabReport | null {
    const tabs = this.listTabs();
    const now = Date.now();
    return tabs.find((item) => item.active && (!requireFresh || now - Date.parse(item.lastSeenAt) < 30_000))
      ?? tabs.find((item) => !requireFresh || now - Date.parse(item.lastSeenAt) < 30_000)
      ?? null;
  }

  private resolveSelector(selectorId: string) {
    this.prune();
    const cached = this.selectors.get(selectorId);
    if (!cached) throw new Error("Cốc Cốc selector expired; inspect the tab again.");
    return cached;
  }

  private clearTabSelectors(tabId: number) {
    for (const [key, value] of this.selectors) if (value.tabId === tabId) this.selectors.delete(key);
  }

  private prune() {
    const now = Date.now();
    for (const [tabId, tab] of this.tabs) if (now - Date.parse(tab.lastSeenAt) > 30_000) this.tabs.delete(tabId);
    for (const [key, selector] of this.selectors) if (selector.expiresAt < now || !this.tabs.has(selector.tabId)) this.selectors.delete(key);
    for (const [id, command] of this.commands) {
      if (command.expiresAt >= now) continue;
      this.commands.delete(id);
      const waiter = this.waiters.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(this.timeoutError(command, "Cốc Cốc DOM command expired."));
        this.waiters.delete(id);
      }
    }
  }
}
