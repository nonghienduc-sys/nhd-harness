/* Local-only durable numeric speed metrics. Never sends prompt or response text. */
(() => {
  "use strict";
  const KEY="nhdResponseSpeedSamples", MAX_ROWS=2000;
  const TYPE="NHD_RESPONSE_SPEED_SAMPLE";
  let writes=Promise.resolve();

  const clean=(v,max=90)=>String(v??"").replace(/[\r\n\x00-\x1f]/g," ").trim().slice(0,max);
  const nullableNumber=v=>v===null||v===undefined?null:Number.isFinite(Number(v))?Number(v):null;
  const number=v=>Number.isFinite(Number(v))?Number(v):0;
  function normalize(raw,settings) {
    if (!raw || typeof raw !== "object") throw Error("Missing speed sample.");
    const sampleId=clean(raw.sampleId,100);
    if(!/^[\w-]{8,100}$/.test(sampleId)) throw Error("Invalid sample id.");
    const chars=number(raw.visibleChars),duration=number(raw.observedDecodeMs);
    if(chars<1||chars>1000000||duration<0||duration>3600000)throw Error("Speed sample out of bounds.");
    const count=number(raw.sampleCount);
    const sample={
      sampleId,measuredAtUtc:clean(raw.measuredAtUtc,40),
      modelLabel:clean(settings.nhdResponseSpeedModelLabel||"ChatGPT Plus - model unverified",90),
      workloadLabel:clean(settings.nhdResponseSpeedWorkloadLabel||"general",90),
      timingOrigin:clean(raw.timingOrigin,30),
      completionSignal:clean(raw.completionSignal,30),
      visibilityState:raw.visibilityState==="visible"?"visible":"hidden",
      quality:clean(raw.quality,30),
      visibleChars:Math.floor(chars),
      wordCount:Math.max(0,Math.floor(number(raw.wordCount))),
      sampleCount:Math.max(1,Math.floor(count)),
      timeToFirstVisibleMs:nullableNumber(raw.timeToFirstVisibleMs),
      observedDecodeMs:Math.round(duration),
      totalVisibleElapsedMs:nullableNumber(raw.totalVisibleElapsedMs),
      detectorVersion:clean(raw.detectorVersion,30)
    };
    if(!Number.isFinite(Date.parse(sample.measuredAtUtc)))throw Error("Invalid speed timestamp.");
    return sample;
  }
  async function sendLocalServer(sample) {
    const stored=await chrome.storage.local.get(["endpoint"]);
    const base=String(stored.endpoint||"http://127.0.0.1:39100").replace(/\/$/,"");
    if(!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))return false;
    try {
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),1800);
      try {
        const response=await fetch(base+"/api/benchmarks/response-speed/sample",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify(sample),signal:controller.signal
        });
        return response.ok;
      }finally{clearTimeout(timer);}
    }catch{return false;}
  }
  async function storeSample(raw) {
    const prefs=await chrome.storage.local.get([
      KEY,"nhdResponseSpeedEnabled","nhdResponseSpeedModelLabel","nhdResponseSpeedWorkloadLabel"
    ]);
    if(prefs.nhdResponseSpeedEnabled===false)return {ok:false,reason:"disabled"};
    const sample=normalize(raw,prefs);
    const old=Array.isArray(prefs[KEY])?prefs[KEY]:[];
    if(old.some(v=>v.sampleId===sample.sampleId))return {ok:true,duplicate:true,sampleId:sample.sampleId};
    const samples=[...old.slice(-(MAX_ROWS-1)),sample];
    await chrome.storage.local.set({[KEY]:samples});
    const serverSaved=await sendLocalServer(sample);
    if(serverSaved){
      const refreshed=await chrome.storage.local.get([KEY]);
      const updated=(Array.isArray(refreshed[KEY])?refreshed[KEY]:[]).map(v=>
        v.sampleId===sample.sampleId?{...v,serverSaved:true}:v
      );
      await chrome.storage.local.set({[KEY]:updated});
    }
    return {ok:true,localSaved:true,serverSaved,sampleId:sample.sampleId,count:samples.length};
  }
  async function syncPending() {
    const rows=(await chrome.storage.local.get([KEY]))[KEY]||[];
    let sent=0,failed=0;
    for(const item of rows.slice(-200)){
      if(item.serverSaved)continue;
      if(await sendLocalServer(item)){item.serverSaved=true;sent++;}
      else {failed++;break;} // No background spin when localhost backend is offline.
    }
    if(sent)await chrome.storage.local.set({[KEY]:rows});
    return {ok:true,synced:sent,notSynced:failed,total:rows.length};
  }
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    const type=message?.type;
    if(type!==TYPE && type!=="NHD_RESPONSE_SPEED_SYNC")return false;
    if(type===TYPE && !/^https:\/\/chatgpt\.com\//i.test(String(sender?.tab?.url||sender?.url||""))){
      sendResponse({ok:false,error:"Only ChatGPT page sensor may record samples."});
      return false;
    }
    const execute=()=>type===TYPE?storeSample(message.payload):syncPending();
    const result=writes.then(execute);
    writes=result.catch(()=>{});
    result.then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e.message||e)}));
    return true;
  });
})();
