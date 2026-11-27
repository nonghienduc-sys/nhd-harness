const { app, BrowserWindow, Menu, Tray, nativeImage, shell, desktopCapturer, dialog, Notification, ipcMain } = require("electron");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
const { spawn } = require("child_process");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createDesktopCapabilityPolicy } = require("./desktop-capability-policy.cjs");
const { createLiteUpdater } = require("./lite-updater.cjs");
const { HEALTH_TIMEOUT_MS, decideBackendAction } = require("./watchdog-policy.cjs");

let win;
let tray;
let liteUpdater = null;
let server;
let companion;
let screenServer;
let watchdogTimer;
let recoveryTimer;
let backendRecoveryTimer;
let shuttingDown = false;
let firstHealthyAt = 0;
let failingSince = 0;
let companionFailures = 0;
let backendRestartAttempt = 0;
let backendHealthySince = 0;
let backendStartedAt = 0;
let ensureProcessesPromise = null;
let watchdogRunning = false;
let initialBackendReason = String(process.env.WORKSTATION_RESTART_REASON || '').trim() || null;
const root = path.resolve(__dirname, "..");
const releaseStatePath = path.join(root, "runtime", "release-state.json");
const releasesRoot = path.join(root, "releases");
function readSourceVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "").trim() || null; }
  catch { return null; }
}

function pathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveActiveRelease() {
  const fallback = { id: null, version: readSourceVersion(), path: root, model: "legacy-mutable-dist", generation: null };
  try {
    if (!fs.existsSync(releaseStatePath)) return fallback;
    const state = JSON.parse(fs.readFileSync(releaseStatePath, "utf8").replace(/^\uFEFF/, ""));
    if (state?.schemaVersion !== 1 || state?.model !== "atomic-json-pointer-v1" || !state?.current) throw new Error("release-state schema/model/current is invalid");
    const currentPath = path.resolve(String(state.current.path || ""));
    if (!pathInside(releasesRoot, currentPath) || currentPath === path.resolve(releasesRoot)) throw new Error("current release path escapes releases root");
    if (!fs.existsSync(path.join(currentPath, "dist", "server.js")) || !fs.existsSync(path.join(currentPath, "package.json"))) throw new Error("current release payload is incomplete");
    return { id: String(state.current.id || ""), version: String(state.current.version || ""), path: currentPath, model: state.model, generation: Number(state.generation || 1) };
  } catch (error) {
    bridgeLog("warn", "Atomic release pointer invalid; using legacy root dist", error?.message || String(error));
    return fallback;
  }
}
const screenPort = Number(process.env.WORKSTATION_SCREEN_PORT || 39102);
const dashboardUrl = "http://127.0.0.1:39100/";
const backendHealthUrl = "http://127.0.0.1:39100/api/health/live";
const companionStatusUrl = "http://127.0.0.1:39101/status";
let logFile = null;

function bridgeLog(level, message, detail = "") {
  try {
    if (!logFile) {
      const logDir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      logFile = path.join(logDir, "bridge.log");
    }
    const cleanDetail = String(detail || "").replace(/\r?\n/g, " ").slice(0, 8000);
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${message}${cleanDetail ? ` | ${cleanDetail}` : ""}\n`, "utf8");
  } catch {}
}

const companionSecret = crypto.randomBytes(32).toString("hex");
const desktopCapabilityPolicy = createDesktopCapabilityPolicy(companionSecret);
const packagedDataDir = app.isPackaged ? path.join(app.getPath("userData"), "bridge-data") : null;
const selectorCache = new Map();
const allowedKeys = new Map([["ESCAPE", "{ESC}"], ["TAB", "{TAB}"], ["SHIFT_TAB", "+{TAB}"], ["UP", "{UP}"], ["DOWN", "{DOWN}"], ["LEFT", "{LEFT}"], ["RIGHT", "{RIGHT}"], ["PAGE_UP", "{PGUP}"], ["PAGE_DOWN", "{PGDN}"], ["HOME", "{HOME}"], ["END", "{END}"]]);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

function startProcess(script, label, onExit, extraEnv = {}) {
  const activeRelease = resolveActiveRelease();
  const sourceVersion = readSourceVersion();
  const scriptPath = path.join(activeRelease.path, "dist", script);
  const childEnv = { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: "1", WORKSTATION_COMPANION_SECRET: companionSecret, WORKSTATION_SCREEN_PORT: String(screenPort), NHD_SOURCE_ROOT: root, ...(sourceVersion ? { NHD_SOURCE_VERSION: sourceVersion } : {}), ...(packagedDataDir ? { WORKSTATION_MCP_DATA_DIR: packagedDataDir } : {}) };
  const configuredPython = String(process.env.NHD_PYTHON_PATH || '').trim();
  const defaultPython = 'D:\\NHD-Runtimes\\Python\\mcp-venv\\Scripts\\python.exe';
  const embeddedPython = path.join(root, "runtime", "python-embed", "python.exe");
  childEnv.NHD_PYTHON_PATH = configuredPython && fs.existsSync(configuredPython) ? configuredPython : (fs.existsSync(defaultPython) ? defaultPython : (fs.existsSync(embeddedPython) ? embeddedPython : (configuredPython || "python")));
  childEnv.NHD_YTDLP_PATH = process.env.NHD_YTDLP_PATH || 'D:\\NHD-Runtimes\\Python\\mcp-venv\\Scripts\\yt-dlp.exe';
  if (activeRelease.id) {
    childEnv.NHD_RELEASE_STATE_PATH = releaseStatePath;
    childEnv.NHD_RELEASE_ID = activeRelease.id;
    childEnv.NHD_RELEASE_PATH = activeRelease.path;
  } else {
    delete childEnv.NHD_RELEASE_STATE_PATH; delete childEnv.NHD_RELEASE_ID; delete childEnv.NHD_RELEASE_PATH;
  }
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    windowsHide: true,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeLog("info", `${label} spawned`, `pid=${child.pid || "unknown"} release=${activeRelease.id || "legacy-root"} generation=${activeRelease.generation ?? "legacy"}`);
  child.stdout?.on("data", chunk => bridgeLog("stdout", label, chunk.toString("utf8")));
  child.stderr?.on("data", chunk => bridgeLog("stderr", label, chunk.toString("utf8")));
  child.once("error", error => bridgeLog("error", `${label} process error`, error?.stack || error?.message || String(error)));
  child.once("exit", (code, signal) => {
    bridgeLog(code === 0 ? "info" : "warn", `${label} exited`, `code=${code} signal=${signal || ""}`);
    onExit?.(child, code, signal);
  });
  return child;
}

async function available(url, headers = {}, timeoutMs = 2500) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return response.ok;
  }
  catch { return false; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForChildExit(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
    child.once("exit", () => finish(true));
  });
}

function backendRecoveryDelayMs() {
  const exponent = Math.min(Math.max(backendRestartAttempt - 1, 0), 5);
  const base = Math.min(30000, 1000 * (2 ** exponent));
  return base + Math.floor(Math.random() * 500);
}

function scheduleBackendRecovery(reason = "backend-exit-recovery") {
  if (shuttingDown || backendRecoveryTimer) return;
  backendRestartAttempt = Math.min(backendRestartAttempt + 1, 10);
  const delayMs = backendRecoveryDelayMs();
  bridgeLog("warn", "Backend recovery scheduled", `reason=${reason} attempt=${backendRestartAttempt} delayMs=${delayMs}`);
  backendRecoveryTimer = setTimeout(() => {
    backendRecoveryTimer = null;
    ensureProcesses(reason).catch(error => bridgeLog("error", "Backend recovery failed", error?.stack || error?.message || String(error)));
  }, delayMs);
}

async function waitUntilAvailable(url, headers = {}, maxWaitMs = 30000) {
  const startedAt = Date.now();
  let delay = 250;
  while (!shuttingDown && Date.now() - startedAt < maxWaitMs) {
    if (await available(url, headers, 2500)) return true;
    await sleep(delay);
    delay = Math.min(1500, Math.round(delay * 1.5));
  }
  return false;
}

async function ensureProcesses(reason = "health-ensure") {
  if (ensureProcessesPromise) return ensureProcessesPromise;
  ensureProcessesPromise = (async () => {
    if (!await available(backendHealthUrl)) {
      if (!server || server.exitCode !== null) {
        const startReason = initialBackendReason || reason;
        initialBackendReason = null;
        let child;
        child = startProcess("server.js", "backend", (exitedChild) => {
          if (server === exitedChild) server = null;
          backendHealthySince = 0;
          if (shuttingDown) return;
          scheduleBackendRecovery("backend-exit-recovery");
        }, { WORKSTATION_RESTART_REASON: startReason });
        server = child;
        backendStartedAt = Date.now();
        firstHealthyAt = 0;
        failingSince = 0;
        backendHealthySince = 0;
      }
    }
    if (!await available(companionStatusUrl, { "x-workstation-companion-secret": companionSecret })) {
      if (!companion || companion.exitCode !== null) {
        let child;
        child = startProcess("office-companion.js", "office-companion", (exitedChild) => {
          if (companion === exitedChild) companion = null;
        });
        companion = child;
      }
    }
  })();
  try {
    return await ensureProcessesPromise;
  } finally {
    ensureProcessesPromise = null;
  }
}

function recoveryHtml(message) {
  const safe = String(message || "Starting MCP...").replace(/[&<>"]/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[value]));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark light"><title>Workstation MCP Bridge</title><style>body{font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}.card{max-width:560px;padding:34px 38px;border:1px solid #334155;border-radius:18px;background:#111827;box-shadow:0 18px 50px #0005}.dot{width:12px;height:12px;border-radius:50%;background:#38bdf8;box-shadow:0 0 18px #38bdf8;display:inline-block;margin-right:10px}h2{margin:0 0 12px;font-size:22px}p{color:#94a3b8;line-height:1.55;margin:0}</style></head><body><div class="card"><h2><span class="dot"></span>Workstation MCP Bridge</h2><p>${safe}</p><p style="margin-top:10px">The dashboard will recover automatically when the local backend is ready.</p></div></body></html>`;
}

function showRecoveryPage(message) {
  if (!win || win.isDestroyed()) return;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recoveryHtml(message))}`).catch(() => {});
}

async function loadDashboard(maxWaitMs = 30000) {
  const ready = await waitUntilAvailable(backendHealthUrl, {}, maxWaitMs);
  if (!win || win.isDestroyed() || shuttingDown) return;
  if (!ready) {
    bridgeLog("warn", "Dashboard backend not ready within startup window");
    showRecoveryPage("MCP backend is taking longer than expected to start.");
    scheduleDashboardRecovery(2500);
    return;
  }
  try {
    await win.loadURL(app.isPackaged && !fs.existsSync(path.join(app.getPath("userData"),"bridge-data","setup-complete.json")) ? dashboardUrl+"setup.html" : dashboardUrl);
    bridgeLog("info", "Dashboard loaded");
  } catch (error) {
    bridgeLog("warn", "Dashboard load failed", error?.message || String(error));
    showRecoveryPage("Dashboard load failed. Retrying automatically.");
    scheduleDashboardRecovery(2000);
  }
}

function scheduleDashboardRecovery(delayMs = 1500) {
  if (shuttingDown) return;
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    if (shuttingDown || !win || win.isDestroyed()) return;
    const ready = await available(backendHealthUrl, {}, 2500);
    if (ready) {
      try { await win.loadURL(dashboardUrl); }
      catch (error) {
        bridgeLog("warn", "Recovery load failed", error?.message || String(error));
        scheduleDashboardRecovery(Math.min(delayMs * 2, 8000));
      }
      return;
    }
    showRecoveryPage("Waiting for the MCP backend...");
    scheduleDashboardRecovery(Math.min(delayMs * 2, 8000));
  }, delayMs);
}

async function watchdogTick() {
  if (shuttingDown || watchdogRunning) return;
  watchdogRunning = true;
  try {
    // A probe is associated with the exact child that was current when it began.
    const probedChild = server;
    const backendOk = await available(backendHealthUrl, {}, HEALTH_TIMEOUT_MS);
    if (server === probedChild) {
      const now = Date.now();
      const processAlive = Boolean(server && server.exitCode === null && !server.signalCode);
      const action = decideBackendAction({
        now, startedAt: backendStartedAt, firstHealthyAt, failingSince, healthOk: backendOk, processAlive,
      });
      if (action === "ok") {
        if (!firstHealthyAt) firstHealthyAt = now;
        failingSince = 0;
        if (!backendHealthySince) backendHealthySince = now;
        if (backendRestartAttempt > 0 && now - backendHealthySince >= 60000) {
          bridgeLog("info", "Backend remained healthy; restart backoff reset", `previousAttempt=${backendRestartAttempt}`);
          backendRestartAttempt = 0;
        }
      } else {
        backendHealthySince = 0;
        if (!failingSince) failingSince = now;
        const failingForMs = Math.max(0, now - failingSince);
        bridgeLog("warn", "Backend health check failed", `failingForMs=${failingForMs} action=${action} processAlive=${processAlive}`);
        if (action === "restart") {
          const child = server;
          const reason = processAlive ? "continuous-health-failure" : "process-exited";
          bridgeLog("warn", "Backend unhealthy; requesting controlled restart", `reason=${reason} failingForMs=${failingForMs} pid=${child?.pid || "unknown"}`);
          if (processAlive && child) {
            try { child.kill(); } catch (error) { bridgeLog("warn", "Backend terminate request failed", error?.message || String(error)); }
            let exited = await waitForChildExit(child, 8000);
            if (!exited && child.exitCode === null && !child.signalCode) {
              bridgeLog("warn", "Backend did not exit after graceful wait; forcing termination", `pid=${child.pid || "unknown"}`);
              try { child.kill("SIGKILL"); } catch (error) { bridgeLog("warn", "Backend force terminate failed", error?.message || String(error)); }
              exited = await waitForChildExit(child, 3000);
            }
            if (!exited) bridgeLog("error", "Backend process still has not exited; refusing overlapping spawn", `pid=${child.pid || "unknown"}`);
          } else {
            scheduleBackendRecovery("watchdog-recovery");
          }
          scheduleDashboardRecovery(1200);
        }
      }
    }

    const companionOk = await available(companionStatusUrl, { "x-workstation-companion-secret": companionSecret }, 5000);
    if (companionOk) {
      companionFailures = 0;
    } else {
      companionFailures += 1;
      bridgeLog("warn", "Office Companion health check failed", `count=${companionFailures}`);
      if (companionFailures >= 3) {
        const child = companion;
        if (child && child.exitCode === null) {
          try { child.kill(); } catch {}
          await waitForChildExit(child, 5000);
        }
        await ensureProcesses("companion-watchdog-recovery");
        companionFailures = 0;
      }
    }
  } finally {
    watchdogRunning = false;
  }
}

function startWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    watchdogTick().catch(error => bridgeLog("error", "Watchdog tick failed", error?.stack || error?.message || String(error)));
  }, 10000);
}

function sourceInfo(source) {
  return { id: source.id, name: source.name, kind: source.id.startsWith("screen:") ? "screen" : "window", displayId: source.display_id || null };
}

async function sources(thumbnailSize = { width: 0, height: 0 }) {
  return desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize, fetchWindowIcons: false });
}

function runAutomation(action, payload = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const script = path.join(root, "office", "desktop_automation.ps1");
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action, "-PayloadBase64", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error("Desktop automation timed out.")); }, timeoutMs);
    child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)));
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || output || `Desktop automation exited with ${code}.`));
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error("Desktop automation returned invalid JSON.")); }
    });
  });
}

function cacheControls(windowId, controls) {
  selectorCache.clear();
  return controls.map(control => {
    const selectorId = `ui-${crypto.randomBytes(12).toString("hex")}`;
    const cached = { ...control, selectorId, windowId: String(windowId), createdAt: Date.now() };
    selectorCache.set(selectorId, cached);
    return cached;
  });
}

function safeControl(selectorId, action, approval) {
  const control = selectorCache.get(String(selectorId || ""));
  if (!control || Date.now() - control.createdAt > 5 * 60 * 1000) throw new Error("UI selector is unknown, expired, or stale. Inspect the window again.");
  const decision = desktopCapabilityPolicy.classifyControl(control, action);
  if (decision.blocked) throw new Error("This control is platform-hard-denied by desktop safety policy.");
  if (decision.category) desktopCapabilityPolicy.verifyApproval(approval, control, decision.category, decision.mode);
  return control;
}
function escapeSendKeys(text) {
  return String(text).replace(/[+^%~(){}\[\]]/g, value => `{${value}}`);
}

function startScreenServer() {
  const api = express();
  api.disable("x-powered-by");
  api.use(express.json({ limit: "64kb" }));
  api.use((request, response, next) => {
    if (request.headers["x-workstation-companion-secret"] !== companionSecret) return response.status(401).json({ error: "Unauthorized companion request." });
    next();
  });
  api.get("/status", async (_request, response) => {
    try {
      const list = await sources();
      response.json({ sourceCount: list.length, windowCount: list.filter((item) => item.id.startsWith("window:")).length, displayCount: list.filter((item) => item.id.startsWith("screen:")).length });
    } catch (error) { response.status(500).json({ error: error.message || String(error) }); }
  });
  api.get("/sources", async (_request, response) => {
    try { response.json({ sources: (await sources()).map(sourceInfo) }); }
    catch (error) { response.status(500).json({ error: error.message || String(error) }); }
  });
  api.post("/capture", async (request, response) => {
    try {
      const sourceId = String(request.body?.sourceId || "");
      const maxWidth = Math.min(Math.max(Number(request.body?.maxWidth || 1600), 320), 2560);
      const maxHeight = Math.min(Math.max(Number(request.body?.maxHeight || 1000), 240), 1440);
      const source = (await sources({ width: maxWidth, height: maxHeight })).find((item) => item.id === sourceId);
      if (!source) return response.status(404).json({ error: "Screen or window source was not found." });
      if (source.thumbnail.isEmpty()) return response.status(409).json({ error: "The selected source produced an empty capture. It may be minimized or protected." });
      const size = source.thumbnail.getSize();
      response.json({ source: sourceInfo(source), width: size.width, height: size.height, mimeType: "image/png", data: source.thumbnail.toPNG().toString("base64") });
    } catch (error) { response.status(500).json({ error: error.message || String(error) }); }
  });
  api.get("/ui/status", async (_request, response) => {
    try {
      const result = await runAutomation("windows", {});
      response.json({ windowCount: Array.isArray(result.windows) ? result.windows.length : 0, automation: "Windows UI Automation", safetyMode: "approval-gated-host-desktop-v1" });
    } catch (error) { response.status(500).json({ error: error.message || String(error) }); }
  });
  api.get("/ui/windows", async (_request, response) => {
    try { response.json(await runAutomation("windows", {})); }
    catch (error) { response.status(500).json({ error: error.message || String(error) }); }
  });
  api.post("/ui/inspect", async (request, response) => {
    try {
      const windowId = String(request.body?.windowId || "");
      if (!/^\d+$/.test(windowId)) return response.status(400).json({ error: "A valid windowId is required." });
      const result = await runAutomation("inspect", { windowId, maxDepth: Number(request.body?.maxDepth || 12), limit: Number(request.body?.limit || 800) }, 45000);
      const controls = cacheControls(windowId, Array.isArray(result.controls) ? result.controls : []);
      response.json({ windowId, controls, total: Number(result.total || controls.length), truncated: Boolean(result.truncated) });
    } catch (error) { response.status(500).json({ error: error.message || String(error) }); }
  });
  api.post("/ui/action", async (request, response) => {
    try {
      const action = String(request.body?.action || "");
      if (action === "activate") {
        const windowId = String(request.body?.windowId || "");
        if (!/^\d+$/.test(windowId)) return response.status(400).json({ error: "A valid windowId is required." });
        return response.json(await runAutomation("activate", { windowId }));
      }
      if (action === "press_key") {
        const windowId = String(request.body?.windowId || "");
        const key = String(request.body?.key || "").toUpperCase();
        const keySequence = allowedKeys.get(key);
        if (!/^\d+$/.test(windowId) || !keySequence) return response.status(400).json({ error: "Only approved navigation keys are allowed." });
        return response.json(await runAutomation("press_key", { windowId, keySequence }));
      }
      if (action === "scroll") {
        const windowId = String(request.body?.windowId || "");
        const xRatio = Number(request.body?.xRatio);
        const yRatio = Number(request.body?.yRatio);
        const amount = Number(request.body?.amount);
        const direction = String(request.body?.direction || "");
        if (!/^[0-9]+$/.test(windowId) || !Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1 || !Number.isInteger(amount) || amount < 1 || amount > 6 || !["up","down"].includes(direction))
          return response.status(400).json({error:"Invalid bounded reader scroll request."});
        return response.json(await runAutomation("scroll", {windowId,xRatio,yRatio,direction,amount}));
      }
      if (action === "click_point" || action === "double_click_point") {
        const windowId = String(request.body?.windowId || "");
        const xRatio = Number(request.body?.xRatio);
        const yRatio = Number(request.body?.yRatio);
        if (!/^\d+$/.test(windowId) || !Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) return response.status(400).json({ error: "A valid window and normalized click coordinates are required." });
        return response.json(await runAutomation("click_point", { windowId, xRatio, yRatio, doubleClick: action === "double_click_point" }));
      }
      if (action !== "invoke" && action !== "set_text") return response.status(400).json({ error: "Unsupported desktop action." });
      const control = safeControl(request.body?.selectorId, action, request.body?.approval);
      if (action === "set_text") {
        if (control.controlType !== "Edit" && control.controlType !== "ComboBox") return response.status(409).json({ error: "Text can only be entered into editable controls." });
        const text = String(request.body?.text || "").slice(0, 20000);
        return response.json(await runAutomation("set_text", { windowId: control.windowId, runtimeId: control.runtimeId, text, sendKeysText: escapeSendKeys(text) }));
      }
      return response.json(await runAutomation("invoke", { windowId: control.windowId, runtimeId: control.runtimeId }));
    } catch (error) { response.status(409).json({ error: error.message || String(error) }); }
  });
  return new Promise((resolve) => {
    const candidate = api.listen(screenPort, "127.0.0.1");
    candidate.once("listening", () => {
      screenServer = candidate;
      resolve(true);
    });
    candidate.once("error", (error) => {
      if (error?.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      console.error("Screen Companion failed to start:", error);
      resolve(false);
    });
  });
}

function createWindow() {
  win = new BrowserWindow({ width: 1420, height: 920, minWidth: 980, minHeight: 680, title: "Workstation MCP Bridge", webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "lite-update-preload.cjs") } });
  showRecoveryPage("Starting MCP services...");
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || !String(validatedURL || "").startsWith("http://127.0.0.1:39100")) return;
    if (errorCode === -3) return; // ERR_ABORTED is normal during intentional reload/navigation.
    bridgeLog("warn", "Renderer failed to load dashboard", `code=${errorCode} ${errorDescription || ""}`);
    showRecoveryPage("Dashboard temporarily unavailable. Retrying automatically.");
    scheduleDashboardRecovery(1500);
  });
  win.webContents.on("did-finish-load", () => {
    const currentUrl = win?.webContents?.getURL?.() || "";
    if (currentUrl.startsWith(dashboardUrl)) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
      bridgeLog("info", "Dashboard renderer finished loading");
    }
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    bridgeLog("error", "Renderer process gone", JSON.stringify(details || {}));
    scheduleDashboardRecovery(1200);
  });
  win.on("unresponsive", () => {
    bridgeLog("warn", "Dashboard window became unresponsive");
    showRecoveryPage("Dashboard became unresponsive. Recovering...");
    scheduleDashboardRecovery(1500);
  });
  win.on("responsive", () => bridgeLog("info", "Dashboard window responsive again"));
  win.on("close", (event) => { if (!app.isQuitting) { event.preventDefault(); win.hide(); } });
}


let checkingForLiteUpdate = false;
async function handleLiteUpdateRequest({ notifyOnly = false } = {}) {
  if (checkingForLiteUpdate || !liteUpdater) return { ok:false, message:"Update is busy or unavailable" };
  checkingForLiteUpdate = true;
  try {
    const update = await liteUpdater.check();
    if (!update.available) {
      if (!notifyOnly) await dialog.showMessageBox(win, {type:"info",message:"Kiểm tra cập nhật chỉ hỗ trợ ứng dụng Windows đã cài đặt."});
      return {ok:true, ...update};
    }
    if (!update.isNewer) {
      if (!notifyOnly) await dialog.showMessageBox(win, {type:"info",message:"NHD đã ở phiên bản mới nhất.",detail:"Phiên bản "+update.installedVersion});
      return {ok:true, ...update};
    }
    if (notifyOnly) {
      if (Notification.isSupported()) {
        const notification = new Notification({title:"NHD có phiên bản mới "+update.latestVersion,body:"Mở NHD → Check for Updates để xem và cập nhật khi bạn đồng ý."});
        notification.on("click", () => { void handleLiteUpdateRequest(); });
        notification.show();
      }
      return {ok:true, ...update};
    }
    const decision = await dialog.showMessageBox(win, {type:"question",
      buttons:["Tải và xác minh","Để sau"], defaultId:1, cancelId:1, noLink:true,
      message:"NHD Harness Lite "+update.latestVersion+" đã có trên GitHub.",
      detail:"Nguồn: nonghienduc-sys/nhd-harness-downloads. Chỉ tải từ GitHub đã xác minh SHA-256. Chưa cài đặt hoặc đóng ứng dụng khi tải."});
    if (decision.response !== 0) return {ok:true, cancelled:true};
    if (Notification.isSupported()) {
      new Notification({title:"NHD Lite",body:"Đang tải, xác minh SHA-256 và sao lưu cấu hình."}).show();
    }
    const staged = await liteUpdater.prepare();
    win?.setProgressBar(-1);
    const consent = await dialog.showMessageBox(win,{type:"warning",
      buttons:["Cài đặt và kiểm tra rollback","Để sau"], defaultId:1, cancelId:1, noLink:true,
      message:"Bản cập nhật "+staged.targetVersion+" đã xác minh SHA-256.",
      detail:"Đã sao lưu cấu hình. Bộ cài hiện chưa ký số, Windows có thể cảnh báo. Chỉ cài khi bạn chấp thuận. Nếu phiên bản mới không khởi động khỏe, tiến trình giám sát sẽ thử cài lại phiên bản cũ và phục hồi cấu hình. Hãy lưu công việc trước khi tiếp tục."});
    if (consent.response !== 0) return {ok:true, staged:true, targetVersion:staged.targetVersion};
    const started = await liteUpdater.install();
    app.isQuitting = true;
    app.quit();
    return {ok:true, ...started};
  } catch(error) {
    win?.setProgressBar(-1);
    bridgeLog("error", "Lite update failed", error?.message || String(error));
    if (!notifyOnly) await dialog.showMessageBox(win,{type:"error",message:"Không thể cập nhật NHD.",detail:String(error?.message||error)});
    return {ok:false,message:String(error?.message||error)};
  } finally { checkingForLiteUpdate = false; }
}
function trustedUpdaterRenderer(event) {
  try {
    const u = new URL(event.senderFrame.url);
    return u.protocol === "http:" && u.hostname === "127.0.0.1" && u.port === "39100";
  } catch { return false; }
}
ipcMain.handle("nhd:update:status", event => {
  if (!trustedUpdaterRenderer(event)) throw Error("Untrusted update request origin");
  return liteUpdater?.status() || {available:false,phase:"initializing"};
});
ipcMain.handle("nhd:update:prompt", event => {
  if (!trustedUpdaterRenderer(event)) throw Error("Untrusted update request origin");
  return handleLiteUpdateRequest();
});

app.on("second-instance", () => {
  if (win) {
    win.show();
    win.focus();
    scheduleDashboardRecovery(250);
  }
});
app.whenReady().then(async () => {
  if (!hasLock) return;
  bridgeLog("info", "Electron ready", `version=${app.getVersion()} packaged=${app.isPackaged}`);
  liteUpdater = createLiteUpdater({ app, report:(event,data)=>{
    if (event === "progress" && win && !win.isDestroyed()) win.setProgressBar(data.total ? data.bytes/data.total : 0);
    else bridgeLog("info","Lite updater "+event,JSON.stringify(data||{}));
  } });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  await startScreenServer();
  createWindow();
  const icon = nativeImage.createFromPath(process.execPath);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Workstation MCP Bridge");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => { win.show(); win.focus(); scheduleDashboardRecovery(100); } },
    { label: "Open in Browser", click: () => shell.openExternal(dashboardUrl) },
    { label: "Check for Updates", click: () => { void handleLiteUpdateRequest(); } },
    { type: "separator" },
    { label: "Exit Companion", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => { win.show(); scheduleDashboardRecovery(100); });
  await ensureProcesses("electron-startup");
  startWatchdog();
  void loadDashboard(30000);
  void liteUpdater.confirmHealthy().catch(e => bridgeLog("warn","Update health proof failed",e?.message||String(e)));
  liteUpdater.startPeriodic(async () => { await handleLiteUpdateRequest({notifyOnly:true}); });
});
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  shuttingDown = true;
  app.isQuitting = true;
  clearInterval(watchdogTimer);
  liteUpdater?.stopPeriodic();
  clearTimeout(recoveryTimer);
  clearTimeout(backendRecoveryTimer);
  screenServer?.close();
  server?.kill();
  companion?.kill();
  bridgeLog("info", "Electron shutting down");
});






