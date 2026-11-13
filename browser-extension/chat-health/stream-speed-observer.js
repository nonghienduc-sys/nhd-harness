/* ChatGPT web output-speed observer. Numeric metadata only; no prompt/answer bodies. */
(() => {
  "use strict";
  const VERSION = "nhd-ui-observer-v1";
  if (location.hostname !== "chatgpt.com") return;
  if (globalThis.__nhdStreamSpeedObserverVersion === VERSION) return;
  globalThis.__nhdStreamSpeedObserverVersion = VERSION;
  const core = globalThis.NHDStreamSpeedCore;
  if (!core?.buildSample) return;

  const ROLE_SELECTOR = "[data-message-author-role]";
  const STOP_SELECTOR = 'button[data-testid*="stop"],button[aria-label*="Stop"],button[aria-label*="Dừng"]';
  const MAX_OUTPUT_CHARS = 1000000;
  const MIN_DELAY_MS = 120;
  const IDLE_FINISH_MS = 8000;
  const MAX_RUN_MS = 10*60*1000;
  let enabled = true, pending = null, active = null, updateTimer = null, finishTimer = null;
  const knownUsers = new WeakSet(), knownAssistants = new WeakSet();
  const clock = () => performance.now();
  const stopVisible = () => Boolean(document.querySelector(STOP_SELECTOR));
  const randomId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID() :
    "nhd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,12);

  function nodeElement(node) { return node?.nodeType === 1 ? node : node?.parentElement || null; }
  function rootRole(node, expected, allowDescendants = false) {
    const el = nodeElement(node);
    if (!el) return null;
    let found = el.matches?.(ROLE_SELECTOR) ? el : el.closest?.(ROLE_SELECTOR);
    if (found && found.getAttribute("data-message-author-role") === expected) return found;
    if (!allowDescendants) return null;
    found = el.querySelector?.('[data-message-author-role="'+expected+'"]');
    return found || null;
  }
  function outputText(node) {
    const inner = node?.querySelector?.(".markdown") || node?.querySelector?.(".prose") ||
      node?.querySelector?.('[data-testid="message-text"]');
    const raw = String((inner || node)?.textContent || "").trim();
    if (!inner && /^(thinking|working|searching|đang suy nghĩ)(?:\s|[.…:])*/i.test(raw.slice(0,35)) && raw.length < 50) return "";
    return raw.slice(0, MAX_OUTPUT_CHARS);
  }
  function wordsCount(text) { return (String(text).match(/\S+/g) || []).length; }
  function finish(signal) {
    clearTimeout(updateTimer);clearTimeout(finishTimer);
    updateTimer = finishTimer = null;
    if (!active) return;
    const done = active; active = null;
    if (done.firstAt == null || done.visibleChars < 1) return;
    const payload = core.buildSample({
      sampleId:done.sampleId,measuredAtUtc:new Date().toISOString(),
      sentAt:done.sentAt,firstAt:done.firstAt,lastChangeAt:done.lastChangeAt,
      timingOrigin:done.timingOrigin,completionSignal:signal,
      visibilityState:done.visibilityState,visibleChars:done.visibleChars,
      wordCount:done.wordCount,sampleCount:done.sampleCount
    });
    if (!payload) return;
    try { void chrome.runtime.sendMessage({type:"NHD_RESPONSE_SPEED_SAMPLE",payload}); } catch {}
  }
  function checkFinish() {
    finishTimer=null;
    if (!enabled || !active || active.firstAt==null) return;
    const t=clock();
    const idle=t-active.lastChangeAt;
    if (active.sawStop && !stopVisible() && idle>=1500) return finish("ui_complete");
    if (idle>=IDLE_FINISH_MS || t-active.startedAt>=MAX_RUN_MS) return finish("idle_inferred");
    finishTimer=setTimeout(checkFinish,Math.max(400,Math.min(1200,IDLE_FINISH_MS-idle)));
  }
  function scheduleFinish() {
    clearTimeout(finishTimer);
    finishTimer=setTimeout(checkFinish,1000);
  }
  function sampleResponse() {
    updateTimer=null;
    if(!enabled || !active) return;
    const text=outputText(active.node);
    if(!text) return scheduleFinish();
    const at=clock();
    const chars=text.length;
    if (chars!==active.lastChars) {
      if(active.firstAt==null) active.firstAt=at;
      active.lastAt=at;
      active.lastChangeAt=at;
      active.lastChars=chars;
      active.visibleChars=chars;
      active.wordCount=wordsCount(text);
      active.sampleCount++;
    }
    if(stopVisible()) active.sawStop=true;
    scheduleFinish();
  }
  function scheduleSample() {
    if(updateTimer!=null) return;
    updateTimer=setTimeout(sampleResponse,MIN_DELAY_MS);
  }
  function markSent(origin) {
    if(!enabled)return;
    const now=clock();
    if (pending && now-pending.at<2000 && pending.origin==="submit_event") return;
    pending={at:now,origin};
    // Do not finalize a previous response as a complete one merely because
    // a new request is submitted. Its final state remains inferred/partial.
    if(active) finish("idle_inferred");
  }
  function startResponse(node) {
    if(!enabled || !pending) return;
    const t=clock();
    if(t-pending.at>180000){pending=null;return;}
    if(active && active.node===node) return;
    if(active) finish("idle_inferred");
    const source=pending;pending=null;
    active={
      sampleId:randomId(),node,startedAt:t,sentAt:source.at,
      timingOrigin:source.origin,firstAt:null,lastAt:null,lastChangeAt:t,
      lastChars:0,visibleChars:0,wordCount:0,sampleCount:0,
      sawStop:false,visibilityState:document.visibilityState
    };
    scheduleSample();
  }
  function scanMutations(records) {
    if(!enabled)return;
    let relevant=false;
    for(const mutation of records.slice(-120)){
      const targets=[{node:mutation.target,deep:false},...Array.from(mutation.addedNodes || []).slice(0,4).map(node=>({node,deep:true}))];
      for(const target of targets) {
        const user=rootRole(target.node,"user",target.deep);
        if(user && !knownUsers.has(user)){
          knownUsers.add(user);
          if(!pending && !active) markSent("user_turn_dom");
        }
        const assistant=rootRole(target.node,"assistant",target.deep);
        if(assistant){
          relevant=true;
          if(!knownAssistants.has(assistant)){
            knownAssistants.add(assistant); startResponse(assistant);
          }
          if(active?.node===assistant) scheduleSample();
        }
      }
    }
    // A non-text UI mutation may remove the stop button; completion gets
    // checked by the bounded timer while a response is active.
    if(relevant && active && stopVisible())active.sawStop=true;
  }
  function install() {
    if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",install,{once:true});return;}
    const root=document.body || document.documentElement;
    if(!root)return;
    root.querySelectorAll?.('[data-message-author-role="user"]').forEach(e=>knownUsers.add(e));
    root.querySelectorAll?.('[data-message-author-role="assistant"]').forEach(e=>knownAssistants.add(e));
    const observer=new MutationObserver(scanMutations);
    observer.observe(root,{subtree:true,childList:true,characterData:true});
    document.addEventListener("submit",()=>markSent("submit_event"),true);
    document.addEventListener("keydown",event=>{
      if(event.key!=="Enter"||event.shiftKey||event.ctrlKey||event.altKey||event.isComposing)return;
      const el=nodeElement(event.target);
      if(el?.closest?.('textarea,[contenteditable="true"],[role="textbox"]'))markSent("submit_event");
    },true);
    document.addEventListener("click",event=>{
      const button=nodeElement(event.target)?.closest?.("button");
      if(!button)return;
      const a=String(button.getAttribute("aria-label")||button.getAttribute("data-testid")||"").toLowerCase();
      if(/^(send|gửi|submit message|send message)( |$)/i.test(a)||a==="send-button")markSent("submit_event");
    },true);
    window.addEventListener("pagehide",()=>finish("pagehide"));
    chrome.storage?.onChanged?.addListener(changes=>{
      if(changes.nhdResponseSpeedEnabled) {
        enabled=changes.nhdResponseSpeedEnabled.newValue!==false;
        if(!enabled){finish("pagehide");pending=null;}
      }
    });
  }
  try {
    chrome.storage.local.get(["nhdResponseSpeedEnabled"]).then(state=>{
      enabled=state.nhdResponseSpeedEnabled!==false;
      install();
    }).catch(()=>install());
  } catch { install(); }
})();
