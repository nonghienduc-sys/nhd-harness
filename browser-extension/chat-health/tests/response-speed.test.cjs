'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');

test('core calculates UI-only rate, first-visible latency and low-confidence cases',()=>{
  const world={};vm.runInNewContext(fs.readFileSync(path.join(root,'stream-speed-core.js'),'utf8'),world);
  const result=world.NHDStreamSpeedCore.buildSample({
    sampleId:'sample-first',measuredAtUtc:'2026-11-08T00:00:00Z',
    visibleChars:800,wordCount:135,firstAt:2000,lastChangeAt:6000,sentAt:750,
    timingOrigin:'submit_event',completionSignal:'ui_complete',visibilityState:'visible',sampleCount:8
  });
  assert.equal(result.estimatedOutputTokens,200);
  assert.equal(result.estimatedTokensPerSecond,50);
  assert.equal(result.timeToFirstVisibleMs,1250);
  assert.equal(result.quality,'observed');
  const one=world.NHDStreamSpeedCore.buildSample({
    sampleId:'one',visibleChars:15,firstAt:100,lastChangeAt:100,sentAt:90,
    visibilityState:'hidden',sampleCount:1
  });
  assert.equal(one.quality,'partial');
  assert.equal(one.estimatedTokensPerSecond,null);
});

test('observer captures one streamed answer without reading old messages or polling idle',async()=>{
  let t=1000,seq=0,observerCallback;
  const timers=new Map(),events={},sent=[];
  const setTimer=(fn,delay)=>{const id=++seq;timers.set(id,{fn,at:t+delay});return id;};
  function advance(ms){
    const target=t+ms;
    for(let cycle=0;cycle<100;cycle++){
      const due=[...timers.entries()].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!due)break;
      timers.delete(due[0]);t=due[1].at;due[1].fn();
    }
    t=target;
  }
  function element(role,text=''){
    return {
      nodeType:1,textContent:text,parentElement:null,
      matches(s){return s==='[data-message-author-role]';},
      closest(){return null;},
      getAttribute(k){return k==='data-message-author-role'?role:null;},
      querySelector(){return null;}
    };
  }
  const body={querySelectorAll(){return []}};
  const document={
    readyState:'complete',body,visibilityState:'visible',
    querySelector(){return null;},
    addEventListener(name,fn){events[name]=fn;}
  };
  const world={
    document,location:{hostname:'chatgpt.com'},
    performance:{now(){return t;}},
    crypto:{randomUUID(){return 'sample-uuid-1234';}},
    chrome:{
      storage:{local:{async get(){return {}; }},onChanged:{addListener(){}}},
      runtime:{sendMessage(m){sent.push(m);return Promise.resolve({ok:true});}}
    },
    MutationObserver:class {constructor(cb){observerCallback=cb;} observe(){}},
    setTimeout:setTimer,clearTimeout(id){timers.delete(id);},
    window:{addEventListener(name,fn){events['window-'+name]=fn;}},
    Date,console
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'stream-speed-core.js'),'utf8'),world);
  vm.runInNewContext(fs.readFileSync(path.join(root,'stream-speed-observer.js'),'utf8'),world);
  await Promise.resolve();await Promise.resolve();
  assert.equal(timers.size,0,'no background DOM polling while idle');
  assert.equal(typeof observerCallback,'function');
  events.submit({});
  const assistant=element('assistant','A'.repeat(20));
  observerCallback([{target:assistant,addedNodes:[assistant]}]);
  advance(120);
  assert.equal(sent.length,0,'do not finalize on initial text');
  advance(500);
  assistant.textContent='B'.repeat(800);
  observerCallback([{target:assistant,addedNodes:[]}]);
  advance(120);
  advance(9000);
  assert.equal(sent.length,1);
  assert.equal(sent[0].type,'NHD_RESPONSE_SPEED_SAMPLE');
  assert.equal(sent[0].payload.visibleChars,800);
  assert.equal(sent[0].payload.estimatedOutputTokens,200);
  assert.ok(sent[0].payload.estimatedTokensPerSecond>0);
  assert.equal(sent[0].payload.timingOrigin,'submit_event');
  assert.ok(!Object.hasOwn(sent[0].payload,'promptText'));
  assert.ok(!Object.hasOwn(sent[0].payload,'responseText'));
});

test('manifest injects benchmark only into ChatGPT and worker imports isolated logger',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  const matching=manifest.content_scripts.filter(x=>x.js.includes('stream-speed-observer.js'));
  assert.equal(matching.length,1);
  assert.deepEqual(matching[0].matches,['https://chatgpt.com/*']);
  assert.equal(matching[0].js.indexOf('stream-speed-core.js')+1,matching[0].js.indexOf('stream-speed-observer.js'));
  const worker=fs.readFileSync(path.join(root,'tv-recorder-background.js'),'utf8');
  assert.match(worker,/importScripts\("response-speed-background.js"\)/);
});
