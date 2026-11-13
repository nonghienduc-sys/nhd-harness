import test from "node:test";import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";
import {resolveSbceMode,SbceProcess} from "../dist/sbce-process.js";
import {HhtechProvider} from "../dist/sbce-provider.js";

const model=(over={})=>({id:"t1-x",model:"test-model",provider:"hhtech",protocol:"openai",family:"test",tier:"T1",roles:["writer"],enabled:false,vndPerM:350,...over});

test("SBCE mode: env wins, owner file next, otherwise off (fail closed)",()=>{
 const dir=mkdtempSync(join(tmpdir(),"sbce-mode-"));
 assert.deepEqual(resolveSbceMode(undefined,dir),{mode:"off",source:"default"});
 writeFileSync(join(dir,"sbce-mode.json"),"﻿{\"mode\":\"shadow\"}");
 assert.deepEqual(resolveSbceMode(undefined,dir),{mode:"shadow",source:"file"});
 assert.deepEqual(resolveSbceMode("off",dir),{mode:"off",source:"env"});
 assert.deepEqual(resolveSbceMode("bogus",dir),{mode:"off",source:"env"});
 writeFileSync(join(dir,"sbce-mode.json"),"{\"mode\":\"turbo\"}");
 assert.deepEqual(resolveSbceMode(undefined,dir),{mode:"off",source:"default"});
 writeFileSync(join(dir,"sbce-mode.json"),"not json");
 assert.equal(resolveSbceMode(undefined,dir).mode,"off");
});

test("SBCE process allows only the new admin routes",async()=>{
 const p=new SbceProcess(mkdtempSync(join(tmpdir(),"sbce-proc-")),"shadow");
 // Worker not started: valid routes reach the offline check, invalid ones fail on route.
 await assert.rejects(p.request("GET","/admin/models"),/SBCE_WORKER_OFFLINE/);
 await assert.rejects(p.request("POST","/admin/probe",{}),/SBCE_WORKER_OFFLINE/);
});

test("probe sends a fixed tiny prompt even for disabled catalog entries",async()=>{
 let seen;
 const p=new HhtechProvider(async()=>"private-test-key-123",async(url,opts)=>{
  seen={url,body:JSON.parse(opts.body)};
  return new Response(JSON.stringify({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:21,completion_tokens:1}}),{status:200});
 });
 await assert.rejects(p.generate({model:model(),system:"s",prompt:"p",maxTokens:5}),/NOT_APPROVED/);
 const r=await p.probe(model());
 assert.equal(seen.url,"https://hhtechapi.com/v1/chat/completions");
 assert.equal(seen.body.max_tokens,16);
 assert.equal(seen.body.model,"test-model");
 assert.match(seen.body.messages[0].content,/connectivity probe/);
 assert.deepEqual(r.usage,{input:21,output:1,cached:0});
 assert.equal(typeof r.latencyMs,"number");
 await assert.rejects(p.probe(model({provider:"other"})),/NOT_APPROVED/);
});

test("listModels returns sanitized ids only and needs a key",async()=>{
 const none=new HhtechProvider(async()=>null,async()=>{throw Error("no call");});
 await assert.rejects(none.listModels(),/VAULT_NOT_CONFIGURED/);
 let auth;
 const p=new HhtechProvider(async()=>"private-test-key-123",async(url,opts)=>{
  assert.equal(url,"https://hhtechapi.com/v1/models");auth=opts.headers.authorization;
  return new Response(JSON.stringify({data:[{id:"qwen3-coder-plus",owned_by:"x"},{id:"deepseek-v4-flash"},{id:"bad id <script>"}]}),{status:200});
 });
 assert.deepEqual(await p.listModels(),["deepseek-v4-flash","qwen3-coder-plus"]);
 assert.equal(auth,"Bearer private-test-key-123");
 const bad=new HhtechProvider(async()=>"private-test-key-123",async()=>new Response("nope",{status:401}));
 await assert.rejects(bad.listModels(),/SBCE_PROVIDER_HTTP_401/);
});

// P1b: billing reconciliation found per-request minimum charges and hidden Anthropic cache input.
import {actualChargeVnd,preflightMaxCostVnd,billableInputTokens} from "../dist/sbce-budget.js";
import {inspectCatalog} from "../dist/sbce-catalog.js";

test("P1b: per-call floor applies to charge and reservation",()=>{
 // deepseek-v4-flash case: 291/1805 tokens at 350/M is <1, but the account charged 10.
 assert.equal(actualChargeVnd(291,1805,350),1);
 assert.equal(actualChargeVnd(291,1805,350,10),10);
 assert.equal(actualChargeVnd(10_000_000,0,350,10),3500); // floor never lowers a large charge
 assert.equal(actualChargeVnd(42,0,400,0.5),1);           // fractional floor rounds up
 assert.throws(()=>actualChargeVnd(1,1,350,-1),/FLOOR_INVALID/);
 assert.ok(preflightMaxCostVnd(model({minVndPerCall:10}),"s","p",16)>=10);
 assert.equal(preflightMaxCostVnd(model(),"s","p",16),1);
});

test("P1b: billed input never below a byte-based estimate of what was sent",()=>{
 const prompt="x".repeat(3600);
 assert.equal(billableInputTokens(4,"",prompt),Math.ceil((prompt.length+1)/4)); // gateway reported 4
 assert.equal(billableInputTokens(5000,"",prompt),5000);
 assert.throws(()=>billableInputTokens(-1,"s","p"),/USAGE_INVALID/);
});

test("P1b: catalog keeps the stricter floor of entry and owner audit",()=>{
 const audit={confirmedAt:new Date().toISOString(),source:"account_usage",maxVndPerM:350,sampleCount:1,approvedByOwner:true};
 const mk=(entry)=>inspectCatalog({schemaVersion:1,provider:"hhtech",models:[{...model({id:"t1-deepseek",enabled:true,dataLabels:["internal"]}),...entry}]});
 assert.equal(mk({priceAudit:{...audit,minVndPerCall:10}}).models[0].minVndPerCall,10);
 assert.equal(mk({minVndPerCall:12,priceAudit:{...audit,minVndPerCall:10}}).models[0].minVndPerCall,12);
 assert.equal(mk({priceAudit:audit}).models[0].minVndPerCall,0);
 assert.deepEqual(mk({priceAudit:{...audit,minVndPerCall:-1}}).rejected,["SBCE_CATALOG_SCHEMA_INVALID"]);
});

test("P1b: Anthropic usage adds cache creation/read tokens; OpenAI does not double count",async()=>{
 const anth=new HhtechProvider(async()=>"private-test-key-123",async()=>new Response(JSON.stringify({content:[{type:"text",text:"OK"}],usage:{input_tokens:4,cache_creation_input_tokens:900,cache_read_input_tokens:6,output_tokens:204}}),{status:200}));
 const r=await anth.generate({model:model({protocol:"anthropic",enabled:true}),system:"s",prompt:"p",maxTokens:5});
 assert.deepEqual(r.usage,{input:910,output:204,cached:6});
 const oai=new HhtechProvider(async()=>"private-test-key-123",async()=>new Response(JSON.stringify({choices:[{message:{content:"OK"}}],usage:{prompt_tokens:100,completion_tokens:2,prompt_tokens_details:{cached_tokens:80},cache_read_input_tokens:80}}),{status:200}));
 const o=await oai.generate({model:model({enabled:true}),system:"s",prompt:"p",maxTokens:5});
 assert.equal(o.usage.input,100);
});
