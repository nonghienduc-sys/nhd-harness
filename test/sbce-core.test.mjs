import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SBCE_LIMITS, workOrderSchema, validateWorkOrder, eligibleModels, chooseVerifier, nextTier, refuseRedactedWrite, reviewReceipt } from '../dist/sbce-core.js';
import { SbceStore } from '../dist/sbce-store.js';
const order=(n='A')=>({title:'Patch feature '+n,kind:'code_change',goal:'Implement safe feature '+n+' with tests',deliverables:['patch'],acceptance:[{type:'schema'}]});
test('SBCE work order validates limits and is disabled by default',()=>{
 const x=workOrderSchema.parse(order());
 assert.equal(x.budget.vnd,20000);assert.equal(x.budget.minutes,30);
 assert.throws(()=>validateWorkOrder(order(),'off'),/SBCE_DISABLED/);
 assert.throws(()=>validateWorkOrder({...order(),apply_mode:'apply_after_accept'},'shadow'),/SHADOW/);
 assert.throws(()=>workOrderSchema.parse({...order(),budget:{vnd:21000}}));
 assert.equal(validateWorkOrder(order(),'shadow').kind,'code_change');
});
test('SBCE tier routing is deterministic, only hhtech and cross family judge',()=>{
 const models=[
 {id:'a',provider:'hhtech',model:'a',protocol:'openai',tier:'T1',family:'deepseek',roles:['coder'],enabled:true,vndPerM:350},
 {id:'b',provider:'hhtech',model:'b',protocol:'anthropic',tier:'T1',family:'anthropic',roles:['judge'],enabled:true,vndPerM:400},
 {id:'c',provider:'hhtech',model:'c',protocol:'openai',tier:'T1',family:'deepseek',roles:['judge'],enabled:true,vndPerM:300},
 {id:'d',provider:'hhtech',model:'d',protocol:'openai',tier:'T1',family:'unknown',roles:['coder'],enabled:false,vndPerM:100}
 ];
 assert.deepEqual(eligibleModels(models,'coder','T1','public/code').map(x=>x.id),['a']);
 assert.equal(chooseVerifier(models,models[0],'public/code').id,'b');
 assert.equal(nextTier('T1'),'T2');assert.equal(nextTier('T2'),'T3');assert.equal(nextTier('T3'),null);
});
test('Redaction Guard and review cap prevent accidental destructive output',()=>{
 const marker=['[RED','ACTED]'].join('');
 assert.throws(()=>refuseRedactedWrite('normal','new '+marker),/REDACTION_MARKER_WRITE_BLOCKED/);
 assert.doesNotThrow(()=>refuseRedactedWrite('old '+marker,'new '+marker));
 const pack=reviewReceipt({jobId:'j',state:'ready_for_review',summary:'ok',checks:[{name:'schema',ok:true}],costVnd:0,tokensIn:0,tokensOut:0});
 assert.equal(pack.status,'ready_for_review');
 assert.throws(()=>reviewReceipt({jobId:'j',state:'failed',summary:'x'.repeat(8000),checks:[],artifacts:{trace:'t'.repeat(8000)},costVnd:0,tokensIn:0,tokensOut:0}),/TOO_LARGE/);
});
test('Durable job ledger enforces daily reservation and owner-bound review',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sbce-'));const store=new SbceStore(join(dir,'jobs.sqlite'));
 try{
  for(let i=0;i<15;i++)store.submit(validateWorkOrder(order(String(i)),'shadow'),'chatgpt');
  assert.equal(store.budget().remainingVnd,0);
  assert.throws(()=>store.submit(validateWorkOrder(order('16'),'shadow'),'chatgpt'),/DAILY_BUDGET/);
  const first=store.list(1);
  const jid=first[0].id;
  assert.throws(()=>store.review(jid,'chatgpt','accept'),/NOT_READY/);
  store.putReview(jid,{jobId:jid,state:'ready_for_review',summary:'verified',checks:[{name:'L0',ok:true},{name:'L1',ok:true}],costVnd:0,tokensIn:0,tokensOut:0});
  assert.throws(()=>store.review(jid,'claude','accept'),/OWNER_MISMATCH/);
  assert.equal(store.review(jid,'chatgpt','accept').status,'accepted');
  assert.throws(()=>store.setStatus(jid,'applied'),/APPLY_REQUIRES/);
  assert.equal(store.get(jid).status,'accepted');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('review receipt keeps newest attempt records that fit and never fails over them',()=>{
 const attempts=Array.from({length:6},(_,i)=>({attempt:i+1,model:'m'+i,tier:'T1',checks:Array.from({length:12},(_,k)=>({name:'L0_check_'+k,ok:k%2===0})),error:'e'.repeat(500)}));
 const pack=reviewReceipt({jobId:'j',state:'needs_brain',summary:'s'.repeat(2000),checks:[],costVnd:0,tokensIn:0,tokensOut:0,attempts});
 assert.ok(JSON.stringify(pack).length<=SBCE_LIMITS.maxReviewChars);
 assert.ok(pack.attempts.length>=1);
 assert.equal(pack.attempts.at(-1).attempt,6);
 assert.equal(pack.attempts[0].error.length,160);
});
