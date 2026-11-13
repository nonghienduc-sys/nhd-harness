import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,readFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{SbceStore}from'../dist/sbce-store.js';import{validateWorkOrder}from'../dist/sbce-core.js';import{runSbceShadow}from'../dist/sbce-runner.js';
const dir=()=>mkdtempSync(join(tmpdir(),'sbce-runner-'));
const order=(kind)=>validateWorkOrder({title:'Example job',kind,goal:'Produce a correct small draft with verified criteria',deliverables:['artifact'],acceptance:[{type:'rubric',text:'Be accurate and concise'}]},'shadow');
const models=[
 {id:'writer',model:'fake-writer',provider:'hhtech',protocol:'openai',family:'family-a',tier:'T1',roles:['writer','coder'],enabled:true,vndPerM:500,dataLabels:['internal','public/code']},
 {id:'judge',model:'fake-judge',provider:'hhtech',protocol:'openai',family:'family-b',tier:'T1',roles:['judge'],enabled:true,vndPerM:500,dataLabels:['internal','public/code']}
];
const provider={generate:async({model})=>({text:model.id==='judge'?JSON.stringify({pass:true,reason:'Meets rubric'}):'This is a long, well-structured and carefully edited draft text that remains sandbox-only.',usage:{input:200,output:90,cached:0},model:model.model,protocol:'openai'})};
test('SBCE writer gets cross-family L1 and requires Brain acceptance',async()=>{
 const base=dir(),store=new SbceStore(join(base,'db.sqlite'));try{
  const job=store.submit(order('doc_write'),'owner-task');
  const r=await runSbceShadow({store,jobId:job.id,models,generator:provider,artifactRoot:join(base,'artifacts'),mode:'shadow'});
  assert.equal(r.status,'ready_for_review');assert.equal(r.review.checks.length,3);
  assert.equal(r.review.checks.every(x=>x.ok),true);
  assert.match(readFileSync(r.review.artifacts.draft,'utf8'),/well-structured/);
  assert.equal(store.review(job.id,'owner-task','accept').status,'accepted');
  assert.throws(()=>store.setStatus(job.id,'applied'),/APPLY_REQUIRES/);
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
});
test('SBCE code patch never falsely claims machine build/test or applies source',async()=>{
 const base=dir(),store=new SbceStore(join(base,'db.sqlite'));try{
  const job=store.submit(order('code_change'),'owner-task');
  const coding={generate:async()=>({text:'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',usage:{input:50,output:40,cached:0},model:'fake-coder',protocol:'openai'})};
  const r=await runSbceShadow({store,jobId:job.id,models,generator:coding,artifactRoot:join(base,'artifacts'),mode:'shadow'});
  assert.equal(r.status,'needs_brain');
  assert.equal(r.review.checks.find(c=>c.name==='L0_machine_acceptance').ok,false);
  assert.throws(()=>store.review(job.id,'owner-task','accept'),/NOT_READY/);
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
});
test('SBCE with no enabled models stays within budget and escalates',async()=>{
 const base=dir(),store=new SbceStore(join(base,'db.sqlite'));try{
  const job=store.submit(order('doc_write'),'owner-task');
  const r=await runSbceShadow({store,jobId:job.id,models:[],generator:{generate(){throw Error('must not call')}},artifactRoot:join(base,'artifacts'),mode:'shadow'});
  assert.equal(r.status,'needs_brain');assert.equal(r.spentVnd,0);assert.equal(r.review.checks[0].ok,false);
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
});
