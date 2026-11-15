import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workOrderSchema,validateWorkOrder} from '../dist/sbce-core.js';
import {collectContext} from '../dist/mcp-registries/delegation-tools.js';
import {SbceStore} from '../dist/sbce-store.js';
import {runSbceShadow} from '../dist/sbce-runner.js';

const mkOrder=(kind='data_extract',extra={})=>workOrderSchema.parse({
 title:'Windows evidence smoke test',kind,
 goal:'Read the exact version in package.json from verified evidence only',
 deliverables:['Version and cited line'],acceptance:[{type:'rubric',text:'Cite exact file and line'}],
 ...extra
});

test('broker passes line-numbered verified Windows evidence with source file SHA-256',async()=>{
 const body='{\n  "name":"nhd-test",\n  "version":"0.24.35"\n}\n';
 const digest=createHash('sha256').update(body).digest('hex');
 let stats=0;
 const ctx={runtime:{files:{
  stat(){stats++;return {hash:digest}},
  readWithMeta(){return {redacted:false,text:body}}
 }}};
 const {pack,report}=await collectContext(ctx,mkOrder('data_extract',{
   project_root:'D:\\ChatGPT-Workstation-MCP',context_refs:['file:package.json#L1-4']
 }));
 assert.equal(stats,2,'read-back must compare file hashes before and after');
 assert.equal(pack.evidence.length,1);
 assert.match(pack.evidence[0].snippet,/0\.24\.35/);
 assert.match(pack.evidence[0].snippet,/^\s*1\| /);
 assert.equal(report.verified_sources[0].sha256,digest);
 assert.equal(report.pack_sha256,pack.sha256);
});

test('broker fails closed on changed file or missing project root',async()=>{
 const order=mkOrder('data_extract',{project_root:'D:\\ChatGPT-Workstation-MCP',context_refs:['file:package.json#L1-5']});
 const moved=await collectContext({runtime:{files:{stat:(()=>{let n=0;return()=>({hash:(++n===1?'a':'b').repeat(64)})})(),readWithMeta:()=>({redacted:false,text:'version=1'})}}},order);
 assert.equal(moved.pack,null);
 assert.equal(moved.report.skipped[0].reason,'file_changed_or_unverified');
 const missing=await collectContext({runtime:{}},mkOrder('data_extract',{context_refs:['file:package.json#L1-5']}));
 assert.equal(missing.pack,null);
 assert.equal(missing.report.skipped[0].reason,'project_root_required');
});

test('data extraction without evidence never invokes paid model',async()=>{
 const tmp=mkdtempSync(join(tmpdir(),'nhd-evidence-fail-'));
 const store=new SbceStore(join(tmp,'jobs.sqlite'));
 try{
  const order=validateWorkOrder({
   title:'Missing file context',kind:'data_extract',goal:'Read a local file and extract its real version',
   deliverables:['Version'],acceptance:[{type:'rubric',text:'Use evidence'}]
  },'shadow');
  const job=store.submit(order,'brain-task');
  const result=await runSbceShadow({store,jobId:job.id,models:[],generator:{generate:()=>{throw Error('paid call forbidden')}},artifactRoot:join(tmp,'artifacts'),mode:'shadow'});
  assert.equal(result.status,'needs_brain');
  assert.equal(result.spentVnd,0);
  assert.equal(result.review.checks.find(c=>c.name==='L0_data_evidence_available')?.ok,false);
 }finally{store.close();rmSync(tmp,{recursive:true,force:true})}
});

test('unstructured L1 judge triggers different independent verifier on same draft',async()=>{
 const tmp=mkdtempSync(join(tmpdir(),'nhd-judge-alt-'));
 const store=new SbceStore(join(tmp,'jobs.sqlite'));
 const models=[
  {id:'writer',model:'test-writer',family:'a',tier:'T1',provider:'hhtech',protocol:'openai',roles:['writer'],enabled:true,vndPerM:600,dataLabels:['internal']},
  {id:'judge-invalid',model:'test-bad-judge',family:'b',tier:'T1',provider:'hhtech',protocol:'openai',roles:['judge'],enabled:true,vndPerM:100,dataLabels:['internal']},
  {id:'judge-valid',model:'test-good-judge',family:'c',tier:'T1',provider:'hhtech',protocol:'openai',roles:['judge'],enabled:true,vndPerM:800,dataLabels:['internal']}
 ];
 const calls=[];
 try{
  const order=validateWorkOrder({
   title:'Structured L1 failover',kind:'doc_write',
   goal:'Write a short accurate paragraph for testing independent judge fallback',
   deliverables:['A paragraph'],acceptance:[{type:'rubric',text:'Clear and accurate'}]
  },'shadow');
  const job=store.submit(order,'brain-task');
  const generator={generate:async({model})=>{
   calls.push(model.id);
   const text=model.id==='writer'?'This is an original, detailed, safe, complete paragraph with enough content to pass the deterministic shape check.':model.id==='judge-invalid'?'unstructured judgment':JSON.stringify({pass:true,reason:'Meets rubric'});
   return {text,usage:{input:120,output:80,cached:0},model:model.model,protocol:'openai'};
  }};
  const result=await runSbceShadow({store,jobId:job.id,models,generator,artifactRoot:join(tmp,'artifacts'),mode:'shadow'});
  assert.equal(result.status,'ready_for_review');
  assert.deepEqual(calls,['writer','judge-invalid','judge-valid']);
  assert.equal(result.review.checks.find(c=>c.name==='L1_cross_family_judge').ok,true);
 }finally{store.close();rmSync(tmp,{recursive:true,force:true})}
});


test('false BLOCKED answer is rejected by deterministic L0 despite supplied evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nhd-false-block-'));
 const store=new SbceStore(join(dir,'jobs.sqlite'));
 try{
  const evidence=[{source:'package.json',locator:'package.json:1-4',snippet:'1| {\n2| "name":"bridge",\n3| "version":"0.24.36"\n4| }',label:'internal'}];
  const digest=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const order=validateWorkOrder({
   title:'Source based version extraction',kind:'data_extract',
   goal:'Extract exact package.json version from context evidence and cite locator',
   deliverables:['Version and locator'],acceptance:[{type:'rubric',text:'Grounded version citation'}],
   context_pack:{evidence,sha256:digest,untrusted:true},
   budget:{vnd:500,minutes:3,max_attempts:1}
  },'shadow');
  const job=store.submit(order,'test-brain');
  let calls=0;
  const result=await runSbceShadow({store,jobId:job.id,artifactRoot:join(dir,'artifacts'),mode:'shadow',
   models:[{id:'writer',model:'test-writer',family:'a',tier:'T1',provider:'hhtech',protocol:'openai',roles:['writer'],enabled:true,vndPerM:600,dataLabels:['internal']}],
   generator:{generate:async()=>{calls++;return {text:'BLOCKED. The supplied source lines cannot be trusted as a direct local filesystem read, even though the version is visible.',usage:{input:60,output:60,cached:0},model:'test-writer',protocol:'openai'}}}});
  assert.equal(calls,1);
  assert.equal(result.status,'needs_brain');
  assert.equal(result.review.checks.find(c=>c.name==='L0_data_extraction_grounded')?.ok,false);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});

test('grounded data extraction supplies source to independent L1 judge',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nhd-grounded-extract-'));
 const store=new SbceStore(join(dir,'jobs.sqlite'));
 try{
  const evidence=[{source:'package.json',locator:'package.json:1-4',snippet:'1| {\n2| "name":"bridge",\n3| "version":"0.24.36"\n4| }',label:'internal'}];
  const digest=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const order=validateWorkOrder({
   title:'Source based version extraction',kind:'data_extract',
   goal:'Extract exact package.json version from context evidence and cite locator',
   deliverables:['Version and locator'],acceptance:[{type:'rubric',text:'Grounded version citation'}],
   context_pack:{evidence,sha256:digest,untrusted:true}
  },'shadow');
  const job=store.submit(order,'test-brain');
  let judgePrompt='';
  const models=[
   {id:'writer',model:'writer',family:'a',tier:'T1',provider:'hhtech',protocol:'openai',roles:['writer'],enabled:true,vndPerM:500,dataLabels:['internal']},
   {id:'judge',model:'judge',family:'b',tier:'T1',provider:'hhtech',protocol:'openai',roles:['judge'],enabled:true,vndPerM:500,dataLabels:['internal']}
  ];
  const generator={generate:async({model,prompt,system})=>{
    if(model.id==='judge'){judgePrompt=prompt;return {text:JSON.stringify({pass:true,reason:'Source line confirms version'}),usage:{input:100,output:50,cached:0},model:model.model,protocol:'openai'};}
    assert.match(system,/do not claim BLOCKED merely/);
    return {text:'The exact package.json version is 0.24.36, found at package.json:1-4 (line 3), based on the supplied line-numbered source evidence.',usage:{input:100,output:50,cached:0},model:model.model,protocol:'openai'};
  }};
  const result=await runSbceShadow({store,jobId:job.id,models,generator,artifactRoot:join(dir,'artifacts'),mode:'shadow'});
  assert.equal(result.status,'ready_for_review');
  assert.match(judgePrompt,/SOURCE DATA FOR FACT CHECK/);
  assert.match(judgePrompt,/0\.24\.36/);
  assert.equal(result.review.checks.find(c=>c.name==='L0_data_extraction_grounded')?.ok,true);
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
});
