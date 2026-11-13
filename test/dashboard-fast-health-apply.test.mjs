// 20261113-fastfix: performLoad must hand the timedJson result (not the allSettled wrapper) to applyFastSnapshot,
// otherwise every healthy fast snapshot is counted as a miss and the chip shows "MCP reconnecting".
import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import vm from'node:vm';
const app=readFileSync('dashboard/app.js','utf8');
test('performLoad passes fastResult.value to applyFastSnapshot',()=>{
 assert.match(app,/haveHealth=applyFastSnapshot\(fastResult\.value\)/);
 assert.equal(/applyFastSnapshot\(fastResult\)/.test(app),false);
});
test('applyFastSnapshot accepts a timedJson result and resets the failure streak',()=>{
 const src=/function applyFastSnapshot\(result\)\{[\s\S]*?return true\}/.exec(app)[0];
 const ctx={state:null,lastGoodState:null,fastFailureStreak:5,deepFailureStreak:1,livenessFailureStreak:1,lastFastSuccessAt:0,healthRetryTimer:null,healthMeta:{},clearTimeout(){},Date};
 vm.createContext(ctx);vm.runInContext(src+';var ok=applyFastSnapshot({data:{available:true,state:"healthy",ageMs:10,data:{port:39100}},latencyMs:4});',ctx);
 assert.equal(ctx.ok,true);assert.equal(ctx.fastFailureStreak,0);assert.equal(ctx.healthMeta.status,'healthy');assert.equal(ctx.state.port,39100);
});
