const DEFAULT_ENDPOINT = 'http://127.0.0.1:39100';
const TAB_MAP_KEY = 'nhdChatHealthTabMap';

async function endpoint() {
  const stored = await chrome.storage.local.get(['endpoint']);
  return String(stored.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
}

function buildTabKey(tabId, conversationId) { return `${Number.isInteger(tabId) ? tabId : 'unknown'}:${conversationId || 'unknown'}`; }
async function jsonFetch(path, init = {}) {
  const base = await endpoint();
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`NHD MCP returned HTTP ${response.status}`);
  return response.json();
}
async function sendTelemetry(payload) { return jsonFetch('/api/chat-health/report', { method: 'POST', body: JSON.stringify(payload) }); }
async function sendDomPulse(payload, tab) {
  const tabId = Number.isInteger(tab?.id) ? tab.id : null;
  if (!Number.isInteger(tabId)) return { ok: false, commands: [] };
  return jsonFetch('/api/coc-coc-bridge/pulse', { method: 'POST', body: JSON.stringify({ ...payload, tabId, windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null, active: Boolean(tab?.active), title: tab?.title || payload?.pageTitle || '', url: tab?.url || payload?.pageUrl || '' }) });
}
async function sendDomResult(payload) { return jsonFetch('/api/coc-coc-bridge/result', { method: 'POST', body: JSON.stringify(payload || {}) }); }
async function closeDomTab(tabId) { if (Number.isInteger(tabId)) { try { await jsonFetch('/api/coc-coc-bridge/tab-closed', { method: 'POST', body: JSON.stringify({ tabId }) }); } catch {} } }

function tabMeta(tab) { return { tabId: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '', active: Boolean(tab.active), pinned: Boolean(tab.pinned), audible: Boolean(tab.audible), status: tab.status || '', incognito: Boolean(tab.incognito), discarded: Boolean(tab.discarded) }; }
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function executeBackgroundCommand(command) {
  const payload = command.payload || {};
  if (command.type === 'screenshot') {
    const requested = Number(payload.tabId);
    const target = Number.isInteger(requested) ? await chrome.tabs.get(requested) : (await chrome.tabs.query({ lastFocusedWindow: true })).find(tab => tab.active);
    if (!Number.isInteger(target?.id) || !/^https?:\/\//i.test(target.url || '')) throw new Error('Screenshot target must be an HTTP/HTTPS Cốc Cốc tab.');
    const inactiveError = 'cần tab hiện: screenshot chỉ chụp được tab đang hiện; dùng snapshot/inspect cho tab nền';
    if (!target.active) throw new Error(inactiveError);
    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: 72 });
    const after = await chrome.tabs.get(target.id);
    if (!after.active || after.windowId !== target.windowId || after.url !== target.url) throw new Error(inactiveError);
    return { dataUrl, tab: tabMeta(target), page: { title: target.title || '', url: target.url || '' } };
  }
  if (command.type !== 'browser_command') throw new Error(`Unsupported background command ${command.type}`);
  const action = String(payload.action || '');
  if (action === 'list_tabs') return { tabs: (await chrome.tabs.query({})).map(tabMeta) };
  if (action === 'create_tab') return { tab: tabMeta(await chrome.tabs.create({ url: String(payload.url || ''), active: payload.active === true })) };
  const tabId = Number(payload.tabId);
  if (!Number.isInteger(tabId)) throw new Error(`tabId is required for ${action}.`);
  if (action === 'activate_tab') {
    const tab = await chrome.tabs.get(tabId); await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return { tab: tabMeta(await chrome.tabs.get(tabId)) };
  }
  if (action === 'navigate_tab') { await chrome.tabs.update(tabId, { url: String(payload.url || ''), active: payload.active === true }); return { tab: tabMeta(await chrome.tabs.get(tabId)) }; }
  if (action === 'reload_tab') { await chrome.tabs.reload(tabId); return { ok: true, tabId }; }
  if (action === 'back_tab') { await chrome.tabs.goBack(tabId); return { ok: true, tabId }; }
  if (action === 'forward_tab') { await chrome.tabs.goForward(tabId); return { ok: true, tabId }; }
  if (action === 'close_tab') { await chrome.tabs.remove(tabId); return { ok: true, tabId, closed: true }; }
  throw new Error(`Unsupported browser command action: ${action}`);
}

const POLL_ALARM = 'nhd-coc-coc-poll';
const DISCARD_ALARM_PREFIX = 'nhd-coc-coc-discard:';
const DISCARD_IDLE_MS = 5 * 60 * 1000;
const protectedTabs = new Map();
let syncPending = null;
let syncAgain = false;
let pollRunning = false;
let lastSync = 0;

// Serialize inventories so an older response cannot erase a newer tab list.
function syncTabs() {
  if (syncPending) { syncAgain = true; return syncPending; }
  syncPending = (async () => {
    do {
      syncAgain = false;
      const tabs = (await chrome.tabs.query({})).filter(tab => Number.isInteger(tab.id) && /^https?:\/\//i.test(tab.url || '')).map(tabMeta);
      await jsonFetch('/api/coc-coc-bridge/sync-tabs', { method: 'POST', body: JSON.stringify({ tabs }) });
      lastSync = Date.now();
    } while (syncAgain);
  })().finally(() => { syncPending = null; });
  return syncPending;
}

async function protectTab(tab) {
  const name = DISCARD_ALARM_PREFIX + tab.id;
  let state = protectedTabs.get(tab.id);
  if (!state) {
    // An alarm persists across service-worker suspension. Do not change a
    // tab already marked non-discardable for a reason other than this bridge.
    state = { count: 0, owned: false, ready: null };
    state.ready = chrome.alarms.get(name).then(alarm => { state.owned = Boolean(alarm) || tab.autoDiscardable !== false; });
    protectedTabs.set(tab.id, state);
  }
  state.count++;
  try {
    await state.ready;
    if (state.owned) {
      await chrome.alarms.create(name, { when: Date.now() + DISCARD_IDLE_MS });
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    }
    return async () => {
      state.count--;
      if (state.count === 0) {
        if (state.owned) await chrome.alarms.create(name, { when: Date.now() + DISCARD_IDLE_MS });
        else protectedTabs.delete(tab.id);
      }
    };
  } catch (error) {
    state.count--;
    if (state.count === 0 && !state.owned) protectedTabs.delete(tab.id);
    throw error;
  }
}

// The legacy pulse path may win delivery during a poll interruption.
const pulseReleases = new Map();
async function protectPulseCommand(command, tab) {
  if (tab.discarded) throw new Error('tab_sleeping: Cốc Cốc tab is discarded.');
  const release = await protectTab(tab);
  let timer;
  const finish = async () => {
    if (pulseReleases.get(command.id)?.finish !== finish) return;
    pulseReleases.delete(command.id);
    clearTimeout(timer);
    await release().catch(() => {});
  };
  pulseReleases.set(command.id, { tabId: tab.id, finish });
  // Release even if the page disappears or returns no result.
  timer = setTimeout(() => { void finish(); }, Math.max(0, (command.expiresAt || Date.now() + 30000) - Date.now() + 1000));
}

async function restoreDiscardable(tabId) {
  const name = DISCARD_ALARM_PREFIX + tabId;
  const state = protectedTabs.get(tabId);
  if (state?.count > 0) {
    await chrome.alarms.create(name, { when: Date.now() + DISCARD_IDLE_MS });
    return;
  }
  try { await chrome.tabs.update(tabId, { autoDiscardable: true }); }
  catch { /* Closed tab. */ }
  protectedTabs.delete(tabId);
}

function commandError(error) {
  const message = String(error?.message || error);
  return /^(tab_sleeping|bridge_missing|page_slow):/.test(message) ? message : 'page_slow: ' + message;
}

async function executeDomCommand(command) {
  const tabId = Number(command.tabId);
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch (error) { throw new Error('bridge_missing: ' + String(error?.message || error)); }
  if (tab.discarded) throw new Error('tab_sleeping: Cốc Cốc tab is discarded.');
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('bridge_missing: Cốc Cốc DOM bridge accepts HTTP/HTTPS pages only.');
  const release = await protectTab(tab);
  const message = { type: 'NHD_COC_COC_DOM_EXEC', command };
  const ensureFresh = () => {
    if (command.expiresAt && command.expiresAt <= Date.now()) throw new Error('page_slow: Cốc Cốc DOM command expired.');
  };
  const send = async () => {
    ensureFresh();
    return chrome.tabs.sendMessage(tabId, message);
  };
  try {
    let response;
    try { response = await send(); }
    catch (error) {
      // Only retry a proven missing receiver, never an ambiguous response
      // after an action may already have happened.
      if (!/receiving end does not exist|could not establish connection/i.test(String(error?.message || error))) throw error;
      try {
        const current = await chrome.tabs.get(tabId);
        if (current.discarded) throw new Error('tab_sleeping: Cốc Cốc tab is discarded.');
        ensureFresh();
        await chrome.scripting.executeScript({ target: { tabId }, files: ['dom-bridge.js'] });
        response = await send();
      } catch (retryError) {
        const detail = commandError(retryError);
        if (detail.startsWith('tab_sleeping:') || detail.includes('command expired.')) throw new Error(detail);
        throw new Error('bridge_missing: ' + String(retryError?.message || retryError));
      }
    }
    if (!response || response.id !== command.id || typeof response.ok !== 'boolean') throw new Error('page_slow: Cốc Cốc DOM command did not return a valid response.');
    return response;
  } finally { await release().catch(() => {}); }
}

async function dispatchCommand(command) {
  let result;
  try {
    if (command.expiresAt && command.expiresAt <= Date.now()) throw new Error('page_slow: Cốc Cốc DOM command expired.');
    if (command.type === 'screenshot' || command.type === 'browser_command') {
      result = { id: command.id, ok: true, result: await executeBackgroundCommand(command) };
    } else {
      result = await executeDomCommand(command);
      if (!result.ok) result = { ...result, error: commandError(result.error) };
    }
  } catch (error) { result = { id: command.id, ok: false, error: commandError(error) }; }
  // A failed result POST must not cause a command to be replayed.
  await sendDomResult(result);
}

const tabQueues = new Map();
function queueCommand(command) {
  const tabId = command.type === 'browser_command' || command.type === 'screenshot' ? Number(command.payload?.tabId ?? command.tabId) : command.tabId;
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const work = previous.catch(() => {}).then(() => dispatchCommand(command));
  tabQueues.set(tabId, work);
  void work.catch(() => {}).finally(() => { if (tabQueues.get(tabId) === work) tabQueues.delete(tabId); });
  return work;
}

async function pollOnce() {
  const response = await jsonFetch('/api/coc-coc-bridge/next', { method: 'POST', body: JSON.stringify({ timeoutMs: 15000 }) });
  for (const command of response?.commands || []) queueCommand(command);
}
async function pollCommands() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    for (;;) {
      try {
        if (Date.now() - lastSync >= 15000) await syncTabs();
        await pollOnce();
      } catch { await sleep(1000); }
    }
  } finally { pollRunning = false; }
}

function startBridge() {
  void chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  void syncTabs().catch(() => {});
  void pollCommands();
}

async function injectScriptsIntoOpenTabs() {
  let chatTabs = [], webTabs = [];
  try { chatTabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); } catch {}
  try { webTabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }); } catch {}
  for (const tab of chatTabs) if (Number.isInteger(tab?.id)) { try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js', 'stream-speed-core.js', 'stream-speed-observer.js'] }); } catch {} }
  for (const tab of webTabs) if (Number.isInteger(tab?.id)) { try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dom-bridge.js'] }); } catch {} }
}
async function archiveTab(tabKey) { if (tabKey) { try { await jsonFetch(`/api/chat-health/tabs/${encodeURIComponent(tabKey)}/archive`, { method: 'POST', body: '{}' }); } catch {} } }
async function getTabMap() { const data = await chrome.storage.session.get([TAB_MAP_KEY]); return data[TAB_MAP_KEY] || {}; }
async function rememberTab(tabId, tabKey) { if (!Number.isInteger(tabId)) return; const map = await getTabMap(); const previous = map[String(tabId)]; if (previous && previous !== tabKey) await archiveTab(previous); map[String(tabId)] = tabKey; await chrome.storage.session.set({ [TAB_MAP_KEY]: map }); }
async function forgetTab(tabId) { const map = await getTabMap(); const key = map[String(tabId)]; if (key) await archiveTab(key); delete map[String(tabId)]; await chrome.storage.session.set({ [TAB_MAP_KEY]: map }); }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'NHD_COC_COC_DOM_PULSE') {
    (async () => {
      try {
        const result = await sendDomPulse(message.payload || {}, sender.tab || null);
        const domCommands = [];
        for (const command of result.commands || []) {
          if (command.type === 'browser_command' || command.type === 'screenshot') {
            try { const bgResult = await executeBackgroundCommand(command); await sendDomResult({ id: command.id, ok: true, result: bgResult }); }
            catch (error) { await sendDomResult({ id: command.id, ok: false, error: String(error?.message || error) }); }
          } else {
            try {
              await protectPulseCommand(command, sender.tab);
              domCommands.push(command);
            } catch (error) { await sendDomResult({ id: command.id, ok: false, error: commandError(error) }); }
          }
        }
        sendResponse({ ok: true, commands: domCommands });
      } catch (error) { sendResponse({ ok: false, commands: [], error: String(error?.message || error) }); }
    })();
    return true;
  }
  if (message?.type === 'NHD_COC_COC_DOM_RESULT') {
    const release = pulseReleases.get(message.payload?.id);
    sendDomResult(message.payload || {}).then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: error.message })).finally(() => { if (release) void release.finish(); });
    return true;
  }
  if (message?.type !== 'NHD_CHAT_HEALTH_REPORT') return false;
  const tab = sender.tab || null;
  const conversationId = String(message.payload?.conversationId || message.payload?.pagePath || 'unknown');
  const tabId = Number.isInteger(tab?.id) ? tab.id : null;
  const tabKey = buildTabKey(tabId, conversationId);
  const payload = { ...message.payload, tabKey, tabId, windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null, pageTitle: tab?.title || null, url: tab?.url || null };
  rememberTab(tabId, tabKey).then(() => sendTelemetry(payload)).then(result => {
    const badgeArgs = { text: String(result.score ?? '') }; if (Number.isInteger(tabId)) badgeArgs.tabId = tabId; chrome.action.setBadgeText(badgeArgs);
    const colorArgs = { color: result.score >= 80 ? '#18a66b' : result.score >= 65 ? '#d7a311' : result.score >= 50 ? '#e99a22' : '#d94c45' }; if (Number.isInteger(tabId)) colorArgs.tabId = tabId; chrome.action.setBadgeBackgroundColor(colorArgs);
    sendResponse({ ok: true, score: result.score, tabKey: result.tabKey, flushRequested: result.flushRequested === true, handoffReady: Boolean(result.automation?.handoffReady) });
  }).catch(error => { const badgeArgs = { text: '!' }; if (Number.isInteger(tabId)) badgeArgs.tabId = tabId; chrome.action.setBadgeText(badgeArgs); const colorArgs = { color: '#d94c45' }; if (Number.isInteger(tabId)) colorArgs.tabId = tabId; chrome.action.setBadgeBackgroundColor(colorArgs); sendResponse({ ok: false, error: error.message }); });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  void forgetTab(tabId); void closeDomTab(tabId);
  for (const record of pulseReleases.values()) if (record.tabId === tabId) {
    void record.finish().finally(() => chrome.alarms.clear(DISCARD_ALARM_PREFIX + tabId));
  }
  protectedTabs.delete(tabId);
  void chrome.alarms.clear(DISCARD_ALARM_PREFIX + tabId);
  void syncTabs().catch(() => {});
});
chrome.tabs.onUpdated.addListener(() => { void syncTabs().catch(() => {}); });
chrome.tabs.onActivated.addListener(() => { void syncTabs().catch(() => {}); });
chrome.tabs.onCreated.addListener(() => { void syncTabs().catch(() => {}); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) {
    void syncTabs().catch(() => {});
    void pollCommands();
  } else if (alarm.name.startsWith(DISCARD_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(DISCARD_ALARM_PREFIX.length));
    if (Number.isInteger(tabId)) void restoreDiscardable(tabId).catch(() => {});
  }
});
chrome.runtime.onInstalled.addListener(() => { void injectScriptsIntoOpenTabs(); startBridge(); });
chrome.runtime.onStartup.addListener(() => { void injectScriptsIntoOpenTabs(); startBridge(); });
void injectScriptsIntoOpenTabs();
startBridge();
