'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('service worker stores only allowlisted metrics and POSTs to localhost',async()=>{
  const stored={},requests=[];
  let listener=null;
  const world={
    chrome:{
      storage:{local:{
        async get(keys){const result={};for(const k of keys)result[k]=stored[k];return result;},
        async set(obj){Object.assign(stored,obj);}
      }},
      runtime:{onMessage:{addListener(fn){listener=fn;}}}
    },
    AbortController,console,setTimeout,clearTimeout,
    async fetch(url,options){
      requests.push({url,body:options.body});
      return {ok:true};
    }
  };
  const code=fs.readFileSync(path.join(__dirname,'..','response-speed-background.js'),'utf8');
  vm.runInNewContext(code,world);
  assert.equal(typeof listener,'function');
  function send(message,url='https://chatgpt.com/c/demo'){
    return new Promise(resolve=>{
      const keep=listener(message,{tab:{url}},resolve);
      assert.equal(keep,true);
    });
  }
  const sample={
    sampleId:'sample-123456789',measuredAtUtc:'2026-11-08T04:00:00Z',
    visibleChars:800,wordCount:120,observedDecodeMs:4000,
    sampleCount:10,timeToFirstVisibleMs:700,totalVisibleElapsedMs:4700,
    timingOrigin:'submit_event',completionSignal:'ui_complete',
    visibilityState:'visible',quality:'observed',detectorVersion:'test',
    promptText:'PRIVATE PROMPT',responseText:'SECRET RESPONSE'
  };
  const ack=await send({type:'NHD_RESPONSE_SPEED_SAMPLE',payload:sample});
  assert.equal(ack.ok,true);
  assert.equal(ack.localSaved,true);
  assert.equal(ack.serverSaved,true);
  assert.equal(stored.nhdResponseSpeedSamples.length,1);
  assert.equal(stored.nhdResponseSpeedSamples[0].serverSaved,true);
  assert.match(requests[0].url,/^http:\/\/127\.0\.0\.1:39100\/api\/benchmarks\/response-speed\/sample$/);
  assert.doesNotMatch(requests[0].body,/PRIVATE PROMPT|SECRET RESPONSE/);
  assert.equal(JSON.parse(requests[0].body).visibleChars,800);
  const duplicate=await send({type:'NHD_RESPONSE_SPEED_SAMPLE',payload:sample});
  assert.equal(duplicate.duplicate,true);
  assert.equal(stored.nhdResponseSpeedSamples.length,1);
  const rejected=await new Promise(resolve=>listener({type:'NHD_RESPONSE_SPEED_SAMPLE',payload:{...sample,sampleId:'sample-000000000'}},{tab:{url:'https://evil.example/'}},resolve));
  assert.equal(rejected.ok,false);
  assert.equal(stored.nhdResponseSpeedSamples.length,1);
});

test('failed local backend does not lose browser-stored samples',async()=>{
  const stored={},requests=[];
  let listener;
  const env={
    chrome:{storage:{local:{
      async get(keys){return Object.fromEntries(keys.map(k=>[k,stored[k]]));},
      async set(data){Object.assign(stored,data);}
    }},runtime:{onMessage:{addListener(fn){listener=fn;}}}},
    AbortController,console,setTimeout,clearTimeout,
    async fetch(...args){requests.push(args);throw new Error('offline');}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','response-speed-background.js'),'utf8'),env);
  const sample={sampleId:'offline-000001',measuredAtUtc:'2026-11-08T05:00:00Z',
    visibleChars:240,wordCount:50,observedDecodeMs:2800,sampleCount:6,
    timingOrigin:'user_turn_dom',completionSignal:'idle_inferred',quality:'observed',visibilityState:'visible'};
  const res=await new Promise(resolve=>listener({type:'NHD_RESPONSE_SPEED_SAMPLE',payload:sample},{tab:{url:'https://chatgpt.com/c/demo'}},resolve));
  assert.equal(res.ok,true);
  assert.equal(res.serverSaved,false);
  assert.equal(stored.nhdResponseSpeedSamples.length,1);
  assert.equal(stored.nhdResponseSpeedSamples[0].visibleChars,240);
});
