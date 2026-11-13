/* NHD TradingView recorder screenshot gate. Existing NHD service-worker handlers remain imported unchanged. */
importScripts("background.js");
importScripts("response-speed-background.js");
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "NHD_TV_CAPTURE_ACTIVE") return false;
  (async () => {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error("Missing sender tab");
    const source = new URL(String(sender.url || ""));
    if (source.protocol !== "https:" || !/(^|\.)tradingview\.com$/i.test(source.hostname) || !/\/chart(?:\/|$)/i.test(source.pathname)) {
      throw new Error("TradingView chart origin required");
    }
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.url?.split("#")[0] !== sender.tab?.url?.split("#")[0]) {
      throw new Error("Chart tab must be active; no focus switch is performed");
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 67 });
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("Screenshot was not returned");
    return { dataUrl, capturedAt: new Date().toISOString(), tabId, width: null, source: "chrome.tabs.captureVisibleTab" };
  })().then(result => respond({ ok: true, result }), err => respond({ ok: false, error: String(err?.message || err) }));
  return true;
});
