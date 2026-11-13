import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {SbceStore} from '../dist/sbce-store.js';
import {validateWorkOrder} from '../dist/sbce-core.js';
const dir=()=>mkdtempSync(join(tmpdir(),'sbce-bandit-'));
test('only Brain acceptance records verified model statistics and promotes error signatures',()=>{
 const base=dir(),store=new SbceStore(join(base,'jobs.sqlite'));
 try{
  const job=store.submit(validateWorkOrder({title:'Fix issue',kind:'code_change',goal:'Fix a narrow code issue under machine acceptance',deliverables:['patch'],acceptance:[{type:'rubric',text:'Well tested'}]},'shadow'),'brain');
  store.setStatus(job.id,'running');
  store.recordFailureObservation(job.id,'EXEC_BUILD_FAIL','D:\\secret\\demo.ts:21 broken');
  assert.equal(store.verifiedFailureHints('code_change').length,0);
  const call=store.reserveCall(job.id,'coder-v1',400);
  store.settleCall(call.callId,40);
  store.putReview(job.id,{jobId:job.id,state:'ready_for_review',summary:'Verified',checks:[{name:'L0',ok:true},{name:'L1',ok:true}],costVnd:40,tokensIn:20,tokensOut:30});
  assert.equal(store.modelStats('code_change').length,0);
  const accepted=store.review(job.id,'brain','accept');
  assert.equal(accepted.status,'accepted');
  const stats=store.modelStats('code_change');assert.equal(stats[0].accepted,1);
  assert.equal(store.verifiedFailureHints('code_change')[0].code,'EXEC_BUILD_FAIL');
 }finally{store.close();rmSync(base,{recursive:true,force:true});}
});
