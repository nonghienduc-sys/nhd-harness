// 2026-11-14: HHTECH Anthropic route adds ~13k input tokens per call that we never send.
// Reservations ignored them, so charge > reserve -> SBCE_CALL_BILLING_EXCEEDS_CEILING.
import test from "node:test";
import assert from "node:assert/strict";
import {preflightMaxCostVnd,actualChargeVnd,billableInputTokens} from "../dist/sbce-budget.js";
import {expectedCallVnd} from "../dist/sbce-core.js";
import {inspectCatalog} from "../dist/sbce-catalog.js";

const mdl=(extra={})=>({id:"t1-haiku",model:"claude-haiku-4.5",provider:"hhtech",protocol:"anthropic",family:"anthropic",tier:"T1",roles:["writer"],enabled:true,vndPerM:400,minVndPerCall:0,dataLabels:["internal"],...extra});
const system="You are a worker.",prompt="Update the reward video list.";
const charge=(m,reportedIn,out)=>actualChargeVnd(billableInputTokens(reportedIn,system,prompt),out,m.vndPerM,m.minVndPerCall);

test("hidden input tokens: without the field the observed overflow reproduces",()=>{
 const m=mdl();
 assert.ok(charge(m,13006,512)>preflightMaxCostVnd(m,system,prompt,512));
});

test("hidden input tokens: reserve covers gateway-added input with margin",()=>{
 for(const m of [mdl({hiddenInputTokens:13000}),mdl({id:"t3-sonnet",tier:"T3",vndPerM:1200,minVndPerCall:1,hiddenInputTokens:13000})]){
  for(const maxOut of [16,512,2048,8192]){
   const reserve=preflightMaxCostVnd(m,system,prompt,maxOut);
   assert.ok(charge(m,13006,maxOut)<=reserve,`${m.id} maxOut ${maxOut}: observed usage`);
   assert.ok(charge(m,26000,maxOut)<=reserve,`${m.id} maxOut ${maxOut}: 2x hidden usage`);
  }
 }
});

test("hidden input tokens: invalid values are rejected at reservation",()=>{
 for(const v of [-1,1.5,200_001,Number.NaN])
  assert.throws(()=>preflightMaxCostVnd(mdl({hiddenInputTokens:v}),system,prompt,16),/HIDDEN_INPUT_TOKENS_INVALID/);
 assert.equal(preflightMaxCostVnd(mdl({hiddenInputTokens:0}),system,prompt,16),preflightMaxCostVnd(mdl(),system,prompt,16));
});

test("hidden input tokens: expectedCallVnd prices them in for routing",()=>{
 assert.ok(Math.abs(expectedCallVnd(mdl(),1000)-0.4)<1e-9);
 assert.ok(Math.abs(expectedCallVnd(mdl({hiddenInputTokens:13000}),1000)-5.6)<1e-9);
 assert.equal(expectedCallVnd(mdl({hiddenInputTokens:13000,minVndPerCall:10}),1000),10);
});

test("hidden input tokens: catalog accepts non-negative integers only",()=>{
 const audit={confirmedAt:new Date().toISOString(),source:"account_usage",maxVndPerM:400,sampleCount:1,approvedByOwner:true};
 const mk=(extra)=>inspectCatalog({schemaVersion:1,provider:"hhtech",models:[mdl({priceAudit:audit,...extra})]});
 const ok=mk({hiddenInputTokens:13000});
 assert.equal(ok.enabledCount,1);
 assert.equal(ok.models[0].hiddenInputTokens,13000);
 assert.equal(mk({}).models[0].hiddenInputTokens,undefined);
 for(const v of [-1,1.5,200_001]) assert.deepEqual(mk({hiddenInputTokens:v}).rejected,["SBCE_CATALOG_SCHEMA_INVALID"]);
});
