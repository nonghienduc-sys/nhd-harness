import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {SbceStore} from '../dist/sbce-store.js';
import {validateWorkOrder} from '../dist/sbce-core.js';
const order=t=>validateWorkOrder({title:t,kind:'code_change',goal:'Fix a narrow code issue under machine acceptance',deliverables:['patch'],acceptance:[{type:'rubric',text:'Well tested'}]},'shadow');
function withStore(fn){const base=mkdtempSync(join(tmpdir(),'sbce-stuck-')),store=new SbceStore(join(base,'jobs.sqlite'));try{fn(store);}finally{store.close();rmSync(base,{recursive:true,force:true});}}
const force=(store,id,status)=>store.db.prepare('UPDATE sbce_jobs SET status=? WHERE id=?').run(status,id);
const banditRows=store=>store.db.prepare('SELECT COUNT(*) AS n FROM sbce_bandit').get().n;

test('Brain can reject (close) a needs_brain job without a review pack or bandit update',()=>withStore(store=>{
 const job=store.submit(order('first job'),'task-1');
 store.setStatus(job.id,'running');
 const call=store.reserveCall(job.id,'coder-v1',400);store.settleCall(call.callId,40);
 force(store,job.id,'needs_brain');
 assert.throws(()=>store.review(job.id,'task-x','reject'),/SBCE_OWNER_MISMATCH/);
 assert.throws(()=>store.review(job.id,'task-1','accept'),/SBCE_NOT_READY_FOR_REVIEW/);
 const closed=store.review(job.id,'task-1','reject','done by hand');
 assert.equal(closed.status,'failed');
 assert.equal(closed.reason,'done by hand');
 assert.equal(banditRows(store),0);
 const queued=store.submit(order('second job'),'task-1');
 assert.throws(()=>store.review(queued.id,'task-1','reject'),/SBCE_NOT_READY_FOR_REVIEW/);
}));

test('submitting a new job supersedes older needs_brain jobs of the same owner only',()=>{
 withStore(store=>{
  const stuck=store.submit(order('stuck'),'task-1'),ready=store.submit(order('ready'),'task-1');
  force(store,stuck.id,'needs_brain');force(store,ready.id,'ready_for_review');
  const other=store.submit(order('other'),'task-2');force(store,other.id,'needs_brain');
  const fresh=store.submit(order('retry'),'task-1');
  const s=store.get(stuck.id);
  assert.equal(s.status,'cancelled');
  assert.equal(s.reason,'SBCE_SUPERSEDED_BY:'+fresh.id);
  assert.equal(store.get(ready.id).status,'ready_for_review');
  assert.equal(store.get(other.id).status,'needs_brain');
  assert.equal(store.get(fresh.id).status,'queued');
 });
});
