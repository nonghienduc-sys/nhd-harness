import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SbceStore} from '../dist/sbce-store.js';
import {validateWorkOrder} from '../dist/sbce-core.js';
import {runSbceShadow} from '../dist/sbce-runner.js';

test('concise grounded Windows file data extraction passes L0/L1 with source locator',async()=>{
 const root=mkdtempSync(join(tmpdir(),'nhd-short-extract-'));
 const store=new SbceStore(join(root,'jobs.sqlite'));
 try{
  const evidence=[{source:'package.json',locator:'package.json:1-8',snippet:'1| {\n2| "name":"bridge",\n3| "version":"0.24.37",\n4| }',label:'internal'}];
  const order=validateWorkOrder({
   title:'Concise file version extraction',kind:'data_extract',
   goal:'Extract the exact JSON package version with source location',
   deliverables:['Version and locator'],acceptance:[{type:'rubric',text:'Correct version and exact source locator'}],
   context_pack:{evidence,sha256:createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),untrusted:true}
  },'shadow');
  const job=store.submit(order,'test-brain');
  const models=[
   {id:'writer',model:'writer',family:'a',tier:'T1',provider:'hhtech',protocol:'openai',roles:['writer'],enabled:true,vndPerM:500,dataLabels:['internal']},
   {id:'judge',model:'judge',family:'b',tier:'T1',provider:'hhtech',protocol:'openai',roles:['judge'],enabled:true,vndPerM:500,dataLabels:['internal']}
  ];
  let judgeCalls=0;
  const generator={generate:async({model})=>{
   const text=model.id==='writer'?'0.24.37 — package.json:1-8 (line 3)':(judgeCalls++,JSON.stringify({pass:true,reason:'Grounded in cited line'}));
   return {text,usage:{input:90,output:40,cached:0},model:model.model,protocol:'openai'};
  }};
  const result=await runSbceShadow({store,jobId:job.id,models,generator,artifactRoot:join(root,'artifacts'),mode:'shadow'});
  assert.equal(result.status,'ready_for_review');
  assert.equal(result.review.checks.find(c=>c.name==='L0_artifact_shape')?.ok,true);
  assert.equal(result.review.checks.find(c=>c.name==='L0_data_extraction_grounded')?.ok,true);
  assert.equal(result.review.checks.find(c=>c.name==='L1_cross_family_judge')?.ok,true);
  assert.equal(judgeCalls,1);
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
});
