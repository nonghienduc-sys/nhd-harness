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

function tabMeta(tab) { return { tabId: tab.id, windowId: tab.windowId, url: tab.url || '', title: tab.title || '', active: Boolean(tab.active), pinned: Boolean(tab.pinned), audible: Boolean(tab.audible), status: tab.status || '', incognito: Boolean(tab.incognito) }; }
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function executeBackgroundCommand(command) {
  const payload = command.payload || {};
  if (command.type === 'screenshot') {
    const requested = Number(payload.tabId);
    const target = Number.isInteger(requested) ? await chrome.tabs.get(requested) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!target?.id || !/^https?:\/\//i.test(target.url || '')) throw new Error('Screenshot target must be an HTTP/HTTPS Cốc Cốc tab.');
    const previous = (await chrome.tabs.query({ active: true, windowId: target.windowId }))[0];
    if (!target.active) { await chrome.tabs.update(target.id, { active: true }); await chrome.windows.update(target.windowId, { focused: true }); await sleep(180); }
    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: 72 });
    if (previous?.id && previous.id !== target.id) { try { await chrome.tabs.update(previous.id, { active: true }); } catch {} }
    return { dataUrl, tab: tabMeta(target), page: { title: target.title || '', url: target.url || '' } };
  }
  if (command.type !== 'browser_command') throw new Error(`Unsupported background command ${command.type}`);
  const action = String(payload.action || '');
  if (action === 'list_tabs') return { tabs: (await chrome.tabs.query({})).map(tabMeta) };
  if (action === 'create_tab') return { tab: tabMeta(await chrome.tabs.create({ url: String(payload.url || ''), active: payload.active !== false })) };
  const tabId = Number(payload.tabId);
  if (!Number.isInteger(tabId)) throw new Error(`tabId is required for ${action}.`);
  if (action === 'activate_tab') {
    const tab = await chrome.tabs.get(tabId); await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); return { tab: tabMeta(await chrome.tabs.get(tabId)) };
  }
  if (action === 'navigate_tab') { await chrome.tabs.update(tabId, { url: String(payload.url || ''), active: payload.active !== false }); return { tab: tabMeta(await chrome.tabs.get(tabId)) }; }
  if (action === 'reload_tab') { await chrome.tabs.reload(tabId); return { ok: true, tabId }; }
  if (action === 'back_tab') { await chrome.tabs.goBack(tabId); return { ok: true, tabId }; }
  if (action === 'forward_tab') { await chrome.tabs.goForward(tabId); return { ok: true, tabId }; }
  if (action === 'close_tab') { await chrome.tabs.remove(tabId); return { ok: true, tabId, closed: true }; }
  throw new Error(`Unsupported browser command action: ${action}`);
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
          } else domCommands.push(command);
        }
        sendResponse({ ok: true, commands: domCommands });
      } catch (error) { sendResponse({ ok: false, commands: [], error: String(error?.message || error) }); }
    })();
    return true;
  }
  if (message?.type === 'NHD_COC_COC_DOM_RESULT') {
    sendDomResult(message.payload || {}).then(result => sendResponse({ ok: true, result })).catch(error => sendResponse({ ok: false, error: error.message }));
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
chrome.tabs.onRemoved.addListener(tabId => { void forgetTab(tabId); void closeDomTab(tabId); });
chrome.runtime.onInstalled.addListener(() => { void injectScriptsIntoOpenTabs(); });
chrome.runtime.onStartup.addListener(() => { void injectScriptsIntoOpenTabs(); });
void injectScriptsIntoOpenTabs();
