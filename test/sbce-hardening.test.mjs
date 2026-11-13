import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,readFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{SbceStore}from'../dist/sbce-store.js';
import{inspectCatalog}from'../dist/sbce-catalog.js';
import{preflightMaxCostVnd,actualChargeVnd}from'../dist/sbce-budget.js';
import{runSbceShadow}from'../dist/sbce-runner.js';
import{validateWorkOrder}from'../dist/sbce-core.js';

const dir=()=>mkdtempSync(join(tmpdir(),'sbce-qa-'));
const work=(kind='doc_write')=>validateWorkOrder({title:'Hardening job',kind,goal:'Produce a safe and concise technical description',deliverables:['draft'],acceptance:[{type:'rubric',text:'Clear and accurate'}]},'shadow');
const baseline={id:'t1-writer',model:'deepseek-v4-flash',provider:'hhtech',protocol:'openai',family:'deepseek',tier:'T1',roles:['writer'],enabled:true,vndPerM:350,dataLabels:['internal']};
const judge={...baseline,id:'t1-judge',model:'claude-haiku-4.5',family:'anthropic',protocol:'anthropic',roles:['judge'],vndPerM:400};

test('Catalog rejects unchecked, expired and invalid pricing before enabling models',()=>{
 const now=new Date('2026-11-12T12:00:00.000Z'),priceAudit={source:'account_usage',maxVndPerM:700,sampleCount:3,approvedByOwner:true,confirmedAt:'2026-11-11T12:00:00.000Z'};
 const raw={schemaVersion:1,provider:'hhtech',models:[{...baseline,priceAudit},{...judge,priceAudit:{...priceAudit,confirmedAt:'2026-10-11T12:00:00.000Z'}}]};
 const verified=inspectCatalog(raw,now);
 assert.equal(verified.enabledCount,1);assert.equal(verified.models[0].enabled,true);
 assert.equal(verified.models[0].vndPerM,700);
 assert.equal(verified.models[1].enabled,false);
 assert.ok(verified.rejected.includes('SBCE_MODEL_UNCALIBRATED:t1-judge'));
 const withoutAudit=inspectCatalog({schemaVersion:1,provider:'hhtech',models:[baseline]},now);
 assert.equal(withoutAudit.enabledCount,0);
 const forged=inspectCatalog({schemaVersion:1,provider:'hhtech',models:[{...baseline,model:'https://evil.example/a',priceAudit}]},now);
 assert.equal(forged.enabledCount,0);
});
test('Call reservations cannot overspend job, and interrupted request consumes conservative reserved ceiling',()=>{
 const base=dir(),store=new SbceStore(join(base,'db.sqlite'));try{
  const job=store.submit(work(),'owner-1');store.setStatus(job.id,'running');
  const a=store.reserveCall(job.id,'t1-writer',9000);
  const b=store.reserveCall(job.id,'t1-judge',9000);
  assert.throws(()=>store.reserveCall(job.id,'t1-writer',3000),/JOB_BUDGET_EXCEEDED/);
  const paid=store.settleCall(a.callId,100);
  assert.equal(paid.spentVnd,100);
  const unknown=store.settleCall(b.callId,null);
  assert.equal(unknown.spentVnd,9100);
  assert.equal(store.get(job.id).attempts,2);
  assert.throws(()=>store.settleCall(b.callId,5),/NOT_ACTIVE/);
  const c=store.reserveCall(job.id,'t1-writer',500);
  assert.equal(store.recoverInterruptedCalls(),1);
  assert.equal(store.get(job.id).status,'needs_brain');
  assert.equal(store.get(job.id).spentVnd,9600);
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
});
test('Pricing preflight validates inputs and records token usage deterministically',()=>{
 assert.ok(preflightMaxCostVnd(baseline,'system','an instruction',2048)>0);
 assert.throws(()=>preflightMaxCostVnd({...baseline,vndPerM:0},'s','p',10),/PRICE_UNVERIFIED/);
 assert.equal(actualChargeVnd(1000,500,400),1);
 assert.throws(()=>actualChargeVnd(-10,20,400),/USAGE_INVALID/);
});
test('Rejected cross-family judge triggers bounded retry with distinct artifacts then Brain review',async()=>{
 const base=dir(),store=new SbceStore(join(base,'db.sqlite'));
 let writes=0,judges=0;
 const provider={generate:async({model})=>{
  if(model.roles.includes('judge')){judges++;return{text:JSON.stringify({pass:judges===2,reason:judges===2?'Pass':'Please improve clarity'}),usage:{input:100,output:30,cached:0},model:model.model,protocol:model.protocol};}
  writes++;return{text:'An accurate technical explanation of a safe executor and review mechanism. Revision '+writes+' includes a summary and clear acceptance criteria.',usage:{input:200,output:60,cached:0},model:model.model,protocol:model.protocol};
 }};
 try{
  const job=store.submit(work(),'brain-owner');
  const r=await runSbceShadow({store,jobId:job.id,models:[baseline,judge],generator:provider,artifactRoot:join(base,'drafts'),mode:'shadow'});
  assert.equal(r.status,'ready_for_review');
  assert.equal(writes,2);assert.equal(judges,2);
  assert.equal(r.attempts,4);assert.equal(r.spentVnd,4);
  assert.match(readFileSync(r.review.artifacts.draft,'utf8'),/Revision 2/);
  assert.equal(r.review.checks.every(x=>x.ok),true);
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
});
