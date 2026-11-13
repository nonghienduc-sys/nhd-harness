import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { AppConfig } from "./config.js";
import { Store } from "./db.js";
import { canonicalizeBrowserResource, resolveEphemeralOwnerId, resolveTaskRunId } from "./resource-guard.js";

export type BrowserControl = {
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
  bounds: { x: number; y: number; width: number; height: number } | null;
};

export type BrowserWaitCondition =
  | { kind: "url"; equals?: string; contains?: string }
  | { kind: "title"; equals?: string; contains?: string }
  | { kind: "text"; contains: string }
  | { kind: "value"; selectorId: string; equals: string }
  | { kind: "no-navigation"; url: string };

export type BrowserTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
};

export function selectBrowserTarget(pages: BrowserTarget[], preferredId?: string | null, activeId?: string | null): BrowserTarget | null {
  if (preferredId) {
    const preferred = pages.find((page) => page.id === preferredId);
    if (preferred) return preferred;
  }
  if (activeId) {
    const active = pages.find((page) => page.id === activeId);
    if (active) return active;
  }
  return pages.find((page) => page.url === "about:blank")
    ?? pages.find((page) => /^https?:\/\//i.test(page.url))
    ?? pages.find((page) => !/^(?:edge|chrome|devtools|chrome-extension):/i.test(page.url))
    ?? null;
}

type CachedSelector = {
  targetId: string;
  css: string;
  expiresAt: number;
  revision: number;
  meta: Omit<BrowserControl, "selectorId">;
};

const blockedActionPattern = /\b(send|submit|delete|remove|upload|attach|sign\s*in|log\s*in|password|pay|payment|purchase|checkout|transfer|call|video\s*call|place\s*order|buy\s*now)\b/i;
const blockedFieldPattern = /\b(password|passcode|otp|cvv|cvc|card\s*number|credit\s*card|bank\s*account|routing\s*number|upload|attach)\b/i;

function knownBrowserExecutables(): string[] {
  const local = process.env.LOCALAPPDATA ?? "";
  return [
    process.env.WORKSTATION_BROWSER_EXECUTABLE ?? "",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\CocCoc\\Browser\\Application\\browser.exe",
    local ? resolve(local, "CocCoc", "Browser", "Application", "browser.exe") : "",
  ].filter(Boolean);
}

class CdpSession {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const message = JSON.parse(raw) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (!message.id) return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "CDP command failed."));
        else waiter.resolve(message.result ?? {});
      } catch { /* ignore malformed browser events */ }
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("Browser CDP session closed."));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpSession> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser CDP connection timed out.")), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser CDP connection failed.")); }, { once: true });
    });
    return new CdpSession(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser CDP command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

export class BrowserService {
  private process: ChildProcess | null = null;
  private activeTargetId: string | null = null;
  private readonly debugPort: number;
  private readonly profileDir: string;
  private readonly selectors = new Map<string, CachedSelector>();
  private readonly inspectCache = new Map<string, { revision:number; raw:Array<Record<string,unknown>>; at:number }>();
  private inspectConnection: { targetId:string; webSocketDebuggerUrl:string; session:CdpSession } | null = null;
  private inspectSessionReuses = 0;
  private inspectSessionConnects = 0;
  private inspectCacheHits = 0;
  private inspectCacheMisses = 0;
  private batchRuns = 0;
  private readonly executable: string | null;

  constructor(readonly config: AppConfig, readonly store: Store) {
    this.debugPort = Number(process.env.WORKSTATION_BROWSER_PORT ?? (config.port + 20));
    this.profileDir = resolve(config.dataDir, "browser-profile");
    this.executable = knownBrowserExecutables().find((path) => existsSync(path)) ?? null;
  }

  private guardTargetMutation(targetId: string | undefined, taskRunIdInput?: string, operation = "browser_mutation", explicitEphemeralOwnerId?: string) {
    if (typeof (this.store as Store)?.guardResources !== "function") {
      return { ephemeralOwnerId: undefined as string | undefined, releaseEphemeral: () => {} };
    }
    const effectiveTaskRunId = resolveTaskRunId(taskRunIdInput);
    const callerEphemeralOwner = resolveEphemeralOwnerId(explicitEphemeralOwnerId);
    const resources = [canonicalizeBrowserResource("dedicated", "active")];
    if (targetId && targetId !== "active") {
      resources.push(canonicalizeBrowserResource("dedicated", targetId));
    }
    const guard = this.store.guardResources(resources, {
      mode: "write",
      taskRunId: effectiveTaskRunId,
      ephemeralOwnerId: effectiveTaskRunId ? undefined : callerEphemeralOwner,
      operation,
    });
    const ownsLocalEphemeral = !effectiveTaskRunId && !callerEphemeralOwner && Boolean(guard?.ephemeralOwnerId);
    return {
      ephemeralOwnerId: guard?.ephemeralOwnerId,
      releaseEphemeral: () => {
        if (ownsLocalEphemeral && guard?.ephemeralOwnerId && typeof this.store.releaseEphemeralOwnerResources === "function") {
          this.store.releaseEphemeralOwnerResources(guard.ephemeralOwnerId, `${operation}_completed`);
        }
      },
    };
  }

  async status() {
    const reachable = await this.debugReachable();
    let activePage: { title: string; url: string } | null = null;
    if (reachable) {
      try {
        const target = await this.pageTarget();
        activePage = { title: target.title, url: target.url };
      } catch { /* no page yet */ }
    }
    return {
      enabled: this.config.browserEnabled !== false && !this.config.emergencyStop,
      executable: this.executable,
      debugPort: this.debugPort,
      profileDir: this.profileDir,
      running: reachable,
      pid: this.process?.pid ?? null,
      activePage,
      performance: this.performanceStatus(),
    };
  }

  async navigate(urlInput: string, taskRunId?: string) {
    this.assertEnabled();
    const url = this.safeUrl(urlInput);
    const targetGuard = this.guardTargetMutation(this.activeTargetId ?? "active", taskRunId, "browser_navigate");
    try {
      await this.ensureRunning();
      const target = await this.pageTarget();
      this.guardTargetMutation(target.id, taskRunId, "browser_navigate", targetGuard.ephemeralOwnerId);
      const session = await CdpSession.connect(target.webSocketDebuggerUrl);
      try {
        await session.send("Page.enable");
        await session.send("Page.navigate", { url });
        await this.waitReady(session, 15000);
        const page = await this.pageInfo(session);
        this.selectors.clear();
        this.inspectCache.clear();
        this.store.audit("browser_navigate", "success", { url: page.url, title: page.title });
        return page;
      } finally { session.close(); }
    } finally {
      targetGuard.releaseEphemeral();
    }
  }

  async inspect(query = "", limit = 200): Promise<{ page: { title: string; url: string; readyState:string }; controls: BrowserControl[]; total: number; truncated: boolean; domRevision:number; cacheHit:boolean }> {
    this.assertEnabled();
    await this.ensureRunning();
    const target = await this.pageTarget();
    const session = await this.inspectCdpSession(target);
    try {
      await session.send("Runtime.enable");
      const revision = await this.domRevision(session);
      const cacheKey = `${target.id}|${revision}`;
      let raw: Array<Record<string, unknown>>;
      let cacheHit = false;
      const cachedRaw = this.inspectCache.get(cacheKey);
      if (cachedRaw) {
        raw = cachedRaw.raw;
        cacheHit = true;
        this.inspectCacheHits += 1;
      } else {
        this.inspectCacheMisses += 1;
        const expression = `(() => {
          const visible = (el) => { const s=getComputedStyle(el); const r=el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0; };
          const esc = (value) => CSS.escape(String(value));
          const path = (el) => { if (el.id) return '#' + esc(el.id); const parts=[]; let node=el; while(node && node.nodeType===1 && node!==document.documentElement){ let part=node.tagName.toLowerCase(); const parent=node.parentElement; if(parent){ const same=Array.from(parent.children).filter(x=>x.tagName===node.tagName); if(same.length>1) part += ':nth-of-type(' + (same.indexOf(node)+1) + ')'; } parts.unshift(part); node=parent; } return parts.join(' > '); };
          return Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')).filter(visible).slice(0,1000).map(el => {
            const r=el.getBoundingClientRect(); const text=(el.innerText || el.textContent || '').trim().replace(/\s+/g,' ').slice(0,500); const name=(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('placeholder') || '').trim().slice(0,300); const actualType=('type' in el ? String(el.type || '') : String(el.getAttribute('type') || '')).toLowerCase();
            return { css:path(el), tag:el.tagName.toLowerCase(), role:el.getAttribute('role') || '', name, text, type:actualType, href:el.href || '', value:('value' in el ? String(el.value ?? '') : '').slice(0,500), disabled:Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'), formAssociated:Boolean('form' in el && el.form), download:Boolean(el.hasAttribute && el.hasAttribute('download')), bounds:{x:r.x,y:r.y,width:r.width,height:r.height} };
          });
        })()`;
        const evaluated = await session.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (evaluated.exceptionDetails) throw new Error(`Browser DOM inspection failed: ${JSON.stringify(evaluated.exceptionDetails)}`);
        raw = (((evaluated.result as Record<string, unknown> | undefined)?.value ?? []) as Array<Record<string, unknown>>);
        this.inspectCache.set(cacheKey,{revision,raw,at:Date.now()});
        while(this.inspectCache.size>8) this.inspectCache.delete(this.inspectCache.keys().next().value as string);
      }
      const normalizedQuery = query.trim().toLowerCase();
      const filtered = normalizedQuery ? raw.filter((item) => `${item.tag ?? ""} ${item.role ?? ""} ${item.name ?? ""} ${item.text ?? ""} ${item.type ?? ""} ${item.href ?? ""}`.toLowerCase().includes(normalizedQuery)) : raw;
      const bounded = filtered.slice(0, Math.max(1, Math.min(limit, 500)));
      const expiresAt = Date.now() + 5 * 60 * 1000;
      const controls: BrowserControl[] = bounded.map((item, index) => {
        const selectorId = `web-${randomBytes(6).toString("hex")}-${index}`;
        const meta: Omit<BrowserControl, "selectorId"> = { tag:String(item.tag ?? ""), role:String(item.role ?? ""), name:String(item.name ?? ""), text:String(item.text ?? ""), type:String(item.type ?? ""), href:String(item.href ?? ""), value:String(item.value ?? ""), disabled:Boolean(item.disabled), formAssociated:Boolean(item.formAssociated), download:Boolean(item.download), bounds:item.bounds && typeof item.bounds === "object" ? item.bounds as BrowserControl["bounds"] : null };
        this.selectors.set(selectorId,{targetId:target.id,css:String(item.css ?? ""),expiresAt,revision,meta});
        return {selectorId,...meta};
      });
      this.pruneSelectors();
      const page = await this.pageInfo(session);
      this.store.audit("browser_inspect","success",{url:page.url,query:query.slice(0,200),returned:controls.length,total:filtered.length,domRevision:revision,cacheHit});
      return {page,controls,total:filtered.length,truncated:filtered.length>controls.length,domRevision:revision,cacheHit};
    } catch (error) {
      this.resetInspectSession();
      throw error;
    }
  }

  async click(selectorId: string, taskRunId?: string, explicitEphemeralOwnerId?: string) {
    this.assertEnabled();
    const cached = await this.resolveSelector(selectorId);
    this.assertSafeAction(cached.meta);
    if (cached.meta.disabled) throw new Error("Browser control is disabled.");
    const targetGuard = this.guardTargetMutation(cached.targetId, taskRunId, "browser_click", explicitEphemeralOwnerId);
    try {
      const target = await this.pageTarget(cached.targetId);
      const session = await CdpSession.connect(target.webSocketDebuggerUrl);
      try {
        await this.assertSelectorIdentity(session, cached);
        const css = JSON.stringify(cached.css);
        const expression = `(() => { const el=document.querySelector(${css}); if(!el) throw new Error('Browser selector expired.'); el.scrollIntoView({block:'center',inline:'center'}); el.click(); return true; })()`;
        await session.send("Runtime.evaluate", { expression, returnByValue: true });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        const page = await this.pageInfo(session);
        this.selectors.clear();
        this.store.audit("browser_click", "success", { selectorId, url: page.url, control: { tag: cached.meta.tag, role: cached.meta.role, name: cached.meta.name, text: cached.meta.text.slice(0, 200) } });
        return { ok: true, page, control: cached.meta };
      } finally { session.close(); }
    } finally {
      targetGuard.releaseEphemeral();
    }
  }

  async fill(selectorId: string, text: string, taskRunId?: string, explicitEphemeralOwnerId?: string) {
    this.assertEnabled();
    if (text.length > 500) throw new Error("Browser fill text is limited to 500 characters.");
    const cached = await this.resolveSelector(selectorId);
    const description = `${cached.meta.type} ${cached.meta.name} ${cached.meta.text}`;
    if (cached.meta.type === "password" || cached.meta.type === "file" || blockedFieldPattern.test(description)) throw new Error("Sensitive browser field is blocked.");
    if (!(["input", "textarea", "select"].includes(cached.meta.tag) || cached.meta.role === "textbox")) throw new Error("Browser fill is limited to editable text controls.");
    const targetGuard = this.guardTargetMutation(cached.targetId, taskRunId, "browser_fill", explicitEphemeralOwnerId);
    try {
      const target = await this.pageTarget(cached.targetId);
      const session = await CdpSession.connect(target.webSocketDebuggerUrl);
      try {
        await this.assertSelectorIdentity(session, cached);
        const css = JSON.stringify(cached.css);
        const value = JSON.stringify(text);
        const expression = `(() => { const el=document.querySelector(${css}); if(!el) throw new Error('Browser selector expired.'); el.focus(); if(el.isContentEditable){el.textContent=${value};}else{const proto=Object.getPrototypeOf(el); const d=Object.getOwnPropertyDescriptor(proto,'value'); if(d&&d.set)d.set.call(el,${value}); else el.value=${value};} el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
        await session.send("Runtime.evaluate", { expression, returnByValue: true });
        this.store.audit("browser_fill", "success", { selectorId, characters: text.length, control: { tag: cached.meta.tag, name: cached.meta.name } });
        return { ok: true, selectorId, characters: text.length, control: cached.meta };
      } finally { session.close(); }
    } finally {
      targetGuard.releaseEphemeral();
    }
  }

  async wait(milliseconds = 1000) {
    this.assertEnabled();
    const bounded = Math.max(100, Math.min(milliseconds, 10000));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, bounded));
    await this.ensureRunning();
    const target = await this.pageTarget();
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    try { return { waitedMs: bounded, ...(await this.pageInfo(session)) }; }
    finally { session.close(); }
  }

  async waitForCondition(condition: BrowserWaitCondition, timeoutMs = 5000) {
    this.assertEnabled();
    await this.ensureRunning();
    const bounded = Math.max(100, Math.min(timeoutMs, 15000));
    const started = Date.now();

    if (condition.kind === "no-navigation") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, bounded));
      const target = await this.pageTarget();
      const session = await CdpSession.connect(target.webSocketDebuggerUrl);
      try {
        const page = await this.pageInfo(session);
        if (page.url !== condition.url) throw new Error("Browser navigated unexpectedly: " + page.url);
        const result = { matched: true, waitedMs: Date.now() - started, condition, page, evidence: { url: page.url } };
        this.store.audit("browser_wait_condition", "success", { kind: condition.kind, waitedMs: result.waitedMs, url: page.url });
        return result;
      } finally { session.close(); }
    }

    let last: Record<string, unknown> = {};
    while (Date.now() - started <= bounded) {
      const target = await this.pageTarget();
      const session = await CdpSession.connect(target.webSocketDebuggerUrl);
      try {
        const page = await this.pageInfo(session);
        let matched = false;
        let evidence: Record<string, unknown> = { url: page.url, title: page.title };
        if (condition.kind === "url") {
          if (condition.equals == null && condition.contains == null) throw new Error("URL wait condition requires equals or contains.");
          matched = (condition.equals == null || page.url === condition.equals) && (condition.contains == null || page.url.includes(condition.contains));
        } else if (condition.kind === "title") {
          if (condition.equals == null && condition.contains == null) throw new Error("Title wait condition requires equals or contains.");
          matched = (condition.equals == null || page.title === condition.equals) && (condition.contains == null || page.title.includes(condition.contains));
        } else if (condition.kind === "text") {
          const evaluated = await session.send("Runtime.evaluate", { expression: "document.body ? (document.body.innerText || document.body.textContent || '') : ''", returnByValue: true });
          const bodyText = String((evaluated.result as Record<string, unknown> | undefined)?.value ?? "");
          matched = bodyText.includes(condition.contains);
          evidence = { ...evidence, textMatched: matched, textLength: bodyText.length };
        } else if (condition.kind === "value") {
          this.pruneSelectors();
          const cached = this.selectors.get(condition.selectorId);
          if (!cached) throw new Error("Browser selector expired; inspect the page again.");
          if (cached.targetId !== target.id) throw new Error("Browser selector belongs to a different page target.");
          const css = JSON.stringify(cached.css);
          const expression = "(() => { const el=document.querySelector(" + css + "); return el ? String(('value' in el ? el.value : el.textContent) ?? '') : null; })()";
          const evaluated = await session.send("Runtime.evaluate", { expression, returnByValue: true });
          const current = (evaluated.result as Record<string, unknown> | undefined)?.value;
          matched = current === condition.equals;
          evidence = { ...evidence, value: current };
        }
        last = evidence;
        if (matched) {
          const result = { matched: true, waitedMs: Date.now() - started, condition, page, evidence };
          this.store.audit("browser_wait_condition", "success", { kind: condition.kind, waitedMs: result.waitedMs, url: page.url });
          return result;
        }
      } finally { session.close(); }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    this.store.audit("browser_wait_condition", "timeout", { kind: condition.kind, timeoutMs: bounded, last });
    throw new Error("Browser verification condition timed out after " + bounded + "ms.");
  }

  private async inspectCdpSession(target: BrowserTarget) {
    const cached=this.inspectConnection;
    if (cached && cached.targetId===target.id && cached.webSocketDebuggerUrl===target.webSocketDebuggerUrl) { this.inspectSessionReuses += 1; return cached.session; }
    this.resetInspectSession();
    const session=await CdpSession.connect(target.webSocketDebuggerUrl);
    this.inspectConnection={targetId:target.id,webSocketDebuggerUrl:target.webSocketDebuggerUrl,session};
    this.inspectSessionConnects += 1;
    return session;
  }

  private resetInspectSession() {
    const cached=this.inspectConnection; this.inspectConnection=null;
    if(cached){ try{cached.session.close();}catch{} }
  }

  performanceStatus() {
    return { domRevisionTracking:true, inspectCache:{entries:this.inspectCache.size,hits:this.inspectCacheHits,misses:this.inspectCacheMisses,maxEntries:8}, inspectSession:{persistent:true,connects:this.inspectSessionConnects,reuses:this.inspectSessionReuses}, actionBatching:true, batchRuns:this.batchRuns, staleSelectorPolicy:"revision-aware + identity revalidation", ambiguousReplay:false };
  }

  async runBatch(steps: Array<Record<string, unknown>>, taskRunId?: string) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new Error("Browser batch requires 1-20 steps.");
    const targetGuard = this.guardTargetMutation(this.activeTargetId ?? "active", taskRunId, "browser_batch");
    try {
      this.batchRuns += 1;
      const receipts: Array<Record<string, unknown>> = [];
      for (let index=0; index<steps.length; index++) {
        const step=steps[index]; const action=String(step.action ?? "");
        try {
          if (action === "inspect") { receipts.push({index,action,result:await this.inspect(String(step.query ?? ""),Number(step.limit ?? 200))}); continue; }
          if (action === "fill") { const selectorId=String(step.selectorId ?? ""); const value=String(step.text ?? ""); const result=await this.fill(selectorId,value,taskRunId,targetGuard.ephemeralOwnerId); const verification=await this.waitForCondition({kind:"value",selectorId,equals:value},Number(step.timeoutMs ?? 5000)); receipts.push({index,action,result,verification}); continue; }
          if (action === "click") { const selectorId=String(step.selectorId ?? ""); const condition=step.condition as BrowserWaitCondition | undefined; if(!condition) throw new Error("Browser batch click requires an explicit post-condition."); const result=await this.click(selectorId,taskRunId,targetGuard.ephemeralOwnerId); const verification=await this.waitForCondition(condition,Number(step.timeoutMs ?? 5000)); receipts.push({index,action,result,verification}); continue; }
          if (action === "wait_for") { const condition=step.condition as BrowserWaitCondition | undefined; if(!condition) throw new Error("Browser batch wait_for requires condition."); receipts.push({index,action,result:await this.waitForCondition(condition,Number(step.timeoutMs ?? 5000))}); continue; }
          throw new Error(`Unsupported browser batch action: ${action}`);
        } catch (error) {
          throw new Error(`BROWSER_BATCH_ABORTED after ${receipts.length}/${steps.length} completed step(s); executed actions were not replayed. Step ${index} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return {ok:true,stepCount:steps.length,receipts,replayed:false};
    } finally {
      targetGuard.releaseEphemeral();
    }
  }

  async screenshot() {
    this.assertEnabled();
    await this.ensureRunning();
    const target = await this.pageTarget();
    const session = await CdpSession.connect(target.webSocketDebuggerUrl);
    try {
      await session.send("Page.enable");
      const result = await session.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      const data = String(result.data ?? "");
      if (!data) throw new Error("Browser screenshot was empty.");
      const page = await this.pageInfo(session);
      this.store.audit("browser_screenshot", "success", { url: page.url });
      return { page, mimeType: "image/png", data };
    } finally { session.close(); }
  }

  stop() {
    this.resetInspectSession();
    this.selectors.clear();
    this.inspectCache.clear();
    this.activeTargetId = null;
    const child = this.process;
    this.process = null;
    if (child) { try { child.kill(); } catch { /* already gone */ } }
  }

  private async domRevision(session: CdpSession): Promise<number> {
    const expression = `(() => { if(!window.__nhdDomRevisionState){ const state={revision:1}; Object.defineProperty(window,'__nhdDomRevisionState',{value:state,configurable:true}); const bump=()=>{state.revision += 1;}; const root=document.documentElement; if(root){ new MutationObserver(bump).observe(root,{subtree:true,childList:true,characterData:true,attributes:true}); } document.addEventListener('input',bump,true); document.addEventListener('change',bump,true); document.addEventListener('click',bump,true); } return Number(window.__nhdDomRevisionState.revision || 1); })()`;
    const evaluated=await session.send("Runtime.evaluate",{expression,returnByValue:true});
    return Number((evaluated.result as Record<string,unknown>|undefined)?.value ?? 1) || 1;
  }

  private async assertSelectorIdentity(session: CdpSession, cached: CachedSelector) {
    const revision=await this.domRevision(session);
    const css = JSON.stringify(cached.css);
    const expression = "(() => { const el=document.querySelector(" + css + "); if(!el) return null; return {" +
      "tag:el.tagName.toLowerCase()," +
      "role:el.getAttribute('role') || ''," +
      "name:(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('placeholder') || '').trim().slice(0,300)," +
      "text:(el.innerText || el.textContent || '').trim().replace(/\\s+/g,' ').slice(0,500)," +
      "type:('type' in el ? String(el.type || '') : String(el.getAttribute('type') || '')).toLowerCase()," +
      "href:el.href || ''" +
      "}; })()";
    const evaluated = await session.send("Runtime.evaluate", { expression, returnByValue: true });
    const current = (evaluated.result as Record<string, unknown> | undefined)?.value as Record<string, unknown> | null | undefined;
    if (!current) throw new Error("Browser selector expired; inspect the page again.");
    for (const field of ["tag", "type"] as const) if (String(current[field] ?? "") !== String(cached.meta[field] ?? "")) throw new Error("Browser selector identity changed; inspect the page again.");
    if (cached.meta.href && String(current.href ?? "") !== cached.meta.href) throw new Error("Browser selector identity changed; inspect the page again.");
    if (cached.meta.name && String(current.name ?? "") !== cached.meta.name) throw new Error("Browser selector identity changed; inspect the page again.");
    if (!cached.meta.name && cached.meta.text && String(current.text ?? "") !== cached.meta.text) throw new Error("Browser selector identity changed; inspect the page again.");
    cached.revision=revision;
  }

  private assertEnabled() {
    if (this.config.emergencyStop) throw new Error("Browser automation is disabled by Emergency Stop.");
    if (this.config.browserEnabled === false) throw new Error("Browser automation is disabled by the owner.");
  }

  private safeUrl(urlInput: string) {
    const url = new URL(urlInput);
    if (!(["http:", "https:"].includes(url.protocol))) throw new Error("Browser navigation allows HTTP/HTTPS URLs only.");
    return url.toString();
  }

  private assertSafeAction(meta: Omit<BrowserControl, "selectorId">) {
    const description = `${meta.role} ${meta.name} ${meta.text} ${meta.href}`;
    if (blockedActionPattern.test(description)) throw new Error("Browser control is blocked by workstation safety policy.");
    if (meta.type === "file") throw new Error("Browser file picker controls are blocked.");
    if (meta.formAssociated && (meta.type === "submit" || meta.type === "image")) throw new Error("Browser form submission controls are blocked.");
    if (meta.download) throw new Error("Browser download controls are blocked.");
    if (/^(?:mailto|tel|sms|javascript):/i.test(meta.href)) throw new Error("Browser external-protocol or script links are blocked.");
  }

  private async ensureRunning() {
    if (await this.debugReachable()) return;
    if (!this.executable) throw new Error("No supported Chromium browser executable was found.");
    mkdirSync(this.profileDir, { recursive: true });
    this.process = spawn(this.executable, [
      `--remote-debugging-port=${this.debugPort}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--headless=new",
      "--window-size=1280,900",
      "about:blank",
    ], { windowsHide: false, detached: false, stdio: "ignore" });
    this.process.once("exit", () => { this.process = null; this.activeTargetId = null; this.resetInspectSession(); this.selectors.clear(); this.inspectCache.clear(); });
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await this.debugReachable()) {
        this.store.audit("browser_start", "success", { pid: this.process?.pid ?? null, executable: this.executable, debugPort: this.debugPort });
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error("Browser did not expose the CDP endpoint within 10 seconds.");
  }

  private async debugReachable() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`, { signal: AbortSignal.timeout(750) });
      return response.ok;
    } catch { return false; }
  }

  private async targets(): Promise<BrowserTarget[]> {
    const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Browser target discovery failed: ${response.status}`);
    return (await response.json() as Array<Record<string, unknown>>)
      .filter((item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string")
      .map((item) => ({ id: String(item.id), type: String(item.type), title: String(item.title ?? ""), url: String(item.url ?? ""), webSocketDebuggerUrl: String(item.webSocketDebuggerUrl) }));
  }

  private async pageTarget(preferredId?: string): Promise<BrowserTarget> {
    const pages = await this.targets();
    const target = selectBrowserTarget(pages, preferredId, this.activeTargetId);
    if (!target) throw new Error("No safe browser page target is available.");
    this.activeTargetId = target.id;
    return target;
  }

  private async pageInfo(session: CdpSession) {
    const result = await session.send("Runtime.evaluate", { expression: "({title:document.title,url:location.href,readyState:document.readyState})", returnByValue: true });
    const value = ((result.result as Record<string, unknown> | undefined)?.value ?? {}) as Record<string, unknown>;
    return { title: String(value.title ?? ""), url: String(value.url ?? ""), readyState: String(value.readyState ?? "") };
  }

  private async waitReady(session: CdpSession, timeoutMs: number) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const page = await this.pageInfo(session);
        if (page.readyState === "interactive" || page.readyState === "complete") return;
      } catch { /* navigation can temporarily replace execution context */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
    throw new Error("Browser navigation timed out waiting for the document.");
  }

  private async resolveSelector(selectorId: string) {
    this.pruneSelectors();
    const cached = this.selectors.get(selectorId);
    if (!cached) throw new Error("Browser selector expired; inspect the page again.");
    return cached;
  }

  private pruneSelectors() {
    const now = Date.now();
    for (const [key, value] of this.selectors.entries()) if (value.expiresAt < now) this.selectors.delete(key);
  }
}
