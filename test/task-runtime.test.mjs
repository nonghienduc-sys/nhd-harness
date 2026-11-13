import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../dist/db.js';
import { TaskRunManager, TaskRunError } from '../dist/task-runtime.js';

function clock(start=1_000_000){let now=start;return{now:()=>now,advance:(ms)=>{now+=ms;}};}

async function fixture(options={}){
  const dir=await mkdtemp(join(tmpdir(),'nhd-task-runtime-'));
  const c=options.clock??clock();
  const dbPath=join(dir,'workstation.sqlite');
  const store=new Store(dbPath);
  const manager=new TaskRunManager(store,{roots:[dir],maxReferences:options.maxReferences??3,maxCheckpointHistory:options.maxCheckpointHistory??3,maxStepHistory:20,now:c.now});
  return {dir,dbPath,clock:c,store,manager};
}

test('creates durable planned run with bounded budgets and root confinement',async()=>{
  const {dir,manager}=await fixture();
  const run=manager.create({objective:'Prepare a verified report',root:dir,maxSteps:5,maxRuntimeMs:60_000});
  assert.match(run.id,/^task-[a-f0-9]{32}$/);
  assert.equal(run.state,'planned');
  assert.equal(run.root,resolve(dir));
  assert.equal(run.maxSteps,5);
  assert.equal(run.stepCount,0);
  assert.equal(run.activeStepId,null);
  assert.deepEqual(run.references,[]);
});

test('rejects task root outside configured roots',async()=>{
  const {manager}=await fixture();
  assert.throws(()=>manager.create({objective:'x',root:'C:/outside'}),e=>e instanceof TaskRunError&&e.code==='INVALID_ROOT');
});

test('verified step stores only receipt linkage and returns run to running',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.create({objective:'Run one safe step',root:dir});
  run=manager.start(run.id);
  run=manager.beginStep(run.id,{route:'browser.read',description:'Inspect current page'});
  assert.equal(run.state,'running');
  assert.ok(run.activeStepId);
  const stepId=run.activeStepId;
  run=manager.completeStep(run.id,stepId,{verified:true,outcome:'success',receiptId:'receipt-123',note:'Post-condition verified'});
  assert.equal(run.state,'running');
  assert.equal(run.activeStepId,null);
  assert.equal(run.steps[0].state,'verified');
  assert.equal(run.steps[0].receiptId,'receipt-123');
  assert.equal(run.steps[0].note,'Post-condition verified');
});

test('confirmation-required step cannot execute until explicitly confirmed',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Confirmed step',root:dir}).id);
  run=manager.beginStep(run.id,{route:'terminal.preview-confirmed',description:'Run approved command',requiresConfirmation:true});
  assert.equal(run.state,'waiting_confirmation');
  const stepId=run.activeStepId;
  assert.equal(run.steps[0].state,'waiting_confirmation');
  assert.throws(()=>manager.completeStep(run.id,stepId,{verified:true,outcome:'success'}),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
  run=manager.confirmStep(run.id,stepId);
  assert.equal(run.state,'running');
  assert.equal(run.steps[0].state,'running');
  run=manager.completeStep(run.id,stepId,{verified:true,outcome:'success'});
  assert.equal(run.steps[0].state,'verified');
});

test('unverified or failed step fails the run and is never considered verified',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Failure path',root:dir}).id);
  run=manager.beginStep(run.id,{route:'browser.navigate-safe',description:'Navigate once'});
  const stepId=run.activeStepId;
  run=manager.completeStep(run.id,stepId,{verified:false,outcome:'failed',note:'Outcome ambiguous'});
  assert.equal(run.state,'failed');
  assert.equal(run.activeStepId,null);
  assert.equal(run.steps[0].state,'failed');
  assert.throws(()=>manager.start(run.id),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
});

test('step budget is enforced exactly',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Two steps only',root:dir,maxSteps:2}).id);
  for(let i=0;i<2;i++){
    run=manager.beginStep(run.id,{route:'files.read',description:`step ${i+1}`});
    run=manager.completeStep(run.id,run.activeStepId,{verified:true,outcome:'success'});
  }
  assert.equal(run.stepCount,2);
  assert.throws(()=>manager.beginStep(run.id,{route:'files.read',description:'third'}),e=>e instanceof TaskRunError&&e.code==='STEP_LIMIT');
});

test('checkpoint history is bounded and blocked while a step is active',async()=>{
  const {dir,manager}=await fixture({maxCheckpointHistory:2});
  let run=manager.start(manager.create({objective:'Checkpoint test',root:dir}).id);
  run=manager.checkpoint(run.id,{summary:'one',nextAction:'a'});
  run=manager.checkpoint(run.id,{summary:'two',nextAction:'b'});
  run=manager.checkpoint(run.id,{summary:'three',nextAction:'c'});
  assert.deepEqual(run.checkpoints.map(x=>x.summary),['two','three']);
  run=manager.beginStep(run.id,{route:'files.read',description:'active'});
  assert.throws(()=>manager.checkpoint(run.id,{summary:'blocked'}),e=>e instanceof TaskRunError&&e.code==='ACTIVE_STEP');
});

test('reference map is bounded and stores references rather than evidence bodies',async()=>{
  const {dir,manager}=await fixture({maxReferences:2});
  let run=manager.create({objective:'Reference map',root:dir});
  run=manager.addReference(run.id,{kind:'file',label:'Report',location:join(dir,'report.docx'),fingerprint:'sha256:abc'});
  run=manager.addReference(run.id,{kind:'receipt',label:'Browser receipt',location:'receipt-1'});
  assert.equal(run.references.length,2);
  assert.equal(run.references[0].kind,'file');
  assert.equal(run.references[0].fingerprint,'sha256:abc');
  assert.throws(()=>manager.addReference(run.id,{kind:'other',label:'third',location:'x'}),e=>e instanceof TaskRunError&&e.code==='REFERENCE_LIMIT');
});

test('manager restart pauses running run and marks active step interrupted without replay',async()=>{
  const {dir,dbPath,clock:c,store,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Restart recovery',root:dir}).id);
  run=manager.beginStep(run.id,{route:'terminal.preview-confirmed',description:'one execution'});
  const id=run.id;
  const stepId=run.activeStepId;
  store.db.close();
  const store2=new Store(dbPath);
  const manager2=new TaskRunManager(store2,{roots:[dir],now:c.now});
  manager2.recoverAfterRestart();
  const recovered=manager2.get(id);
  assert.equal(recovered.state,'paused');
  assert.equal(recovered.activeStepId,null);
  const step=recovered.steps.find(x=>x.id===stepId);
  assert.equal(step.state,'interrupted');
  assert.match(step.note,/must not be replayed automatically/i);
  assert.equal(recovered.stepCount,1);
  store2.db.close();
});

test('restart also pauses an idle logically-running task so automation never resumes silently',async()=>{
  const {dir,dbPath,clock:c,store,manager}=await fixture();
  const started=manager.start(manager.create({objective:'Idle running task',root:dir}).id);
  store.db.close();
  const store2=new Store(dbPath);
  const manager2=new TaskRunManager(store2,{roots:[dir],now:c.now});
  manager2.recoverAfterRestart();
  assert.equal(manager2.get(started.id).state,'paused');
  store2.db.close();
});

test('checkpoints and references persist across manager restart',async()=>{
  const {dir,dbPath,clock:c,store,manager}=await fixture();
  let run=manager.create({objective:'Durable map',root:dir});
  run=manager.addReference(run.id,{kind:'project',label:'Project root',location:dir});
  run=manager.checkpoint(run.id,{summary:'Source reviewed',nextAction:'Draft section 1'});
  const id=run.id;
  store.db.close();
  const store2=new Store(dbPath);
  const manager2=new TaskRunManager(store2,{roots:[dir],now:c.now});
  const persisted=manager2.get(id);
  assert.equal(persisted.references[0].label,'Project root');
  assert.equal(persisted.checkpoints[0].summary,'Source reviewed');
  assert.equal(persisted.checkpoints[0].nextAction,'Draft section 1');
  store2.db.close();
});

test('runtime expiry marks active step interrupted and run expired',async()=>{
  const c=clock();
  const {dir,manager}=await fixture({clock:c});
  let run=manager.start(manager.create({objective:'Expiring task',root:dir,maxRuntimeMs:2_000}).id);
  run=manager.beginStep(run.id,{route:'browser.read',description:'active at expiry'});
  const stepId=run.activeStepId;
  c.advance(2_001);
  const expired=manager.get(run.id);
  assert.equal(expired.state,'expired');
  assert.equal(expired.activeStepId,null);
  assert.equal(expired.steps.find(x=>x.id===stepId).state,'interrupted');
});

test('cancel conservatively interrupts an active step',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Cancel task',root:dir}).id);
  run=manager.beginStep(run.id,{route:'files.read',description:'active'});
  const stepId=run.activeStepId;
  run=manager.cancel(run.id,'Owner cancelled');
  assert.equal(run.state,'cancelled');
  assert.equal(run.activeStepId,null);
  assert.equal(run.steps.find(x=>x.id===stepId).state,'interrupted');
  assert.equal(run.steps.find(x=>x.id===stepId).note,'Owner cancelled');
});

test('completed run is immutable to new steps/checkpoints',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Complete task',root:dir}).id);
  run=manager.completeRun(run.id);
  assert.equal(run.state,'completed');
  assert.throws(()=>manager.start(run.id),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
  assert.throws(()=>manager.checkpoint(run.id,{summary:'late'}),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
});

test('list can filter durable runs by state',async()=>{
  const {dir,manager}=await fixture();
  const a=manager.create({objective:'A',root:dir});
  const b=manager.start(manager.create({objective:'B',root:dir}).id);
  assert.deepEqual(manager.list('planned').map(x=>x.id),[a.id]);
  assert.deepEqual(manager.list('running').map(x=>x.id),[b.id]);
});


test('Emergency Stop pauses active runs and interrupts in-flight steps without replay',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Emergency task',root:dir}).id);
  run=manager.beginStep(run.id,{route:'terminal.preview-confirmed',description:'in flight'});
  const stepId=run.activeStepId;
  const pausedCount=manager.pauseForEmergencyStop('Emergency Stop enabled.');
  assert.equal(pausedCount,1);
  const paused=manager.get(run.id);
  assert.equal(paused.state,'paused');
  assert.equal(paused.activeStepId,null);
  const step=paused.steps.find(x=>x.id===stepId);
  assert.equal(step.state,'interrupted');
  assert.match(step.note,/must not be replayed automatically/i);
  assert.throws(()=>manager.beginStep(paused.id,{route:'files.read',description:'silent retry'}),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
});

test('Emergency Stop leaves planned paused and completed runs stable',async()=>{
  const {dir,manager}=await fixture();
  const planned=manager.create({objective:'Planned',root:dir});
  let paused=manager.start(manager.create({objective:'Paused',root:dir}).id);
  paused=manager.pause(paused.id);
  let completed=manager.start(manager.create({objective:'Completed',root:dir}).id);
  completed=manager.completeRun(completed.id);
  assert.equal(manager.pauseForEmergencyStop(),0);
  assert.equal(manager.get(planned.id).state,'planned');
  assert.equal(manager.get(paused.id).state,'paused');
  assert.equal(manager.get(completed.id).state,'completed');
});


test('durable task memory rejects credential-like material',async()=>{
  const {dir,manager}=await fixture();
  assert.throws(()=>manager.create({objective:'password=supersecret123',root:dir}),/secret material/i);
  const run=manager.create({objective:'Safe objective',root:dir});
  assert.throws(()=>manager.checkpoint(run.id,{summary:'Bearer abcdefghijklmnopqrstuvwxyz'}),/secret material/i);
  assert.throws(()=>manager.addReference(run.id,{kind:'url',label:'Unsafe URL',location:'https://user:password@example.test/path'}),/secret material/i);
  assert.throws(()=>manager.addReference(run.id,{kind:'other',label:'Key',location:'api_key=abcdefghijk12345'}),/secret material/i);
});

test('task runtime stats expose counts only, not task content',async()=>{
  const {dir,manager}=await fixture();
  const planned=manager.create({objective:'Sensitive business wording should not appear in stats',root:dir});
  let running=manager.start(manager.create({objective:'Running',root:dir}).id);
  let paused=manager.start(manager.create({objective:'Paused',root:dir}).id);
  paused=manager.pause(paused.id);
  const stats=manager.stats();
  assert.equal(stats.total,3);
  assert.equal(stats.byState.planned,1);
  assert.equal(stats.byState.running,1);
  assert.equal(stats.byState.paused,1);
  assert.equal(stats.active,1);
  assert.equal(stats.paused,1);
  assert.equal(JSON.stringify(stats).includes('Sensitive business wording'),false);
  assert.ok(planned.id); assert.ok(running.id); assert.ok(paused.id);
});


test('secondary manager inspection does not trigger false restart recovery',async()=>{
  const {dir,dbPath,clock:c,store,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Concurrent inspector',root:dir}).id);
  run=manager.beginStep(run.id,{route:'files.read',description:'still active'});
  const stepId=run.activeStepId;
  const store2=new Store(dbPath);
  const inspector=new TaskRunManager(store2,{roots:[dir],now:c.now});
  const observed=inspector.get(run.id);
  assert.equal(observed.state,'running');
  assert.equal(observed.activeStepId,stepId);
  assert.equal(observed.steps.find(x=>x.id===stepId).state,'running');
  store2.db.close();
  store.db.close();
});


test('completed run freezes durable references',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Freeze refs',root:dir}).id);
  run=manager.completeRun(run.id);
  assert.throws(()=>manager.addReference(run.id,{kind:'file',label:'late',location:join(dir,'late.txt')}),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
});

test('task route metadata rejects credential-like material',async()=>{
  const {dir,manager}=await fixture();
  const run=manager.start(manager.create({objective:'Route secret guard',root:dir}).id);
  assert.throws(()=>manager.beginStep(run.id,{route:'api_key=supersecretvalue',description:'blocked route'}),/credentials or secret material/i);
});

test('reconciliation transition repairs only an already-expired run and appends audit checkpoint',async()=>{
  const c=clock();
  const {dir,manager}=await fixture({clock:c});
  let run=manager.start(manager.create({objective:'Verified work that may expire before final task close',root:dir,maxRuntimeMs:2_000}).id);
  run=manager.beginStep(run.id,{route:'code.patch',description:'Implement the verified change'});
  run=manager.completeStep(run.id,run.activeStepId,{verified:true,outcome:'success',note:'Implementation complete and regression passed.'});
  c.advance(2_001);
  run=manager.get(run.id);
  assert.equal(run.state,'expired');
  assert.equal(run.activeStepId,null);
  assert.equal(run.steps.every(step=>step.state==='verified'),true);
  run=manager.reconcileExpiredCompletion(run.id,'Memory reconciler normalized verified completion evidence.');
  assert.equal(run.state,'completed');
  assert.match(run.checkpoints.at(-1).summary,/normalized verified completion evidence/i);
  assert.equal(run.checkpoints.at(-1).nextAction,'');
  assert.throws(()=>manager.reconcileExpiredCompletion(manager.create({objective:'Still planned',root:dir}).id),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
});

test('MCP Tasks projection maps durable states without granting execution authority',async()=>{
  const {dir,manager}=await fixture();
  let run=manager.start(manager.create({objective:'Projection task',root:dir,maxRuntimeMs:60_000}).id);
  let projected=manager.protocolTask(run.id);
  assert.equal(projected.resultType,'complete');
  assert.equal(projected.status,'working');
  assert.equal(projected.adapterOnly,true);
  assert.equal(projected.ttlMs,60_000);
  run=manager.beginStep(run.id,{route:'office.write',description:'Needs task-state confirmation',requiresConfirmation:true});
  projected=manager.protocolTask(run.id);
  assert.equal(projected.status,'input_required');
  assert.equal(Object.keys(projected.inputRequests).length,1);
  assert.match(JSON.stringify(projected.inputRequests),/elicitation\/create/);
  assert.equal(manager.agentCycle(run.id).phase,'input_required');
  run=manager.confirmStep(run.id,run.activeStepId);
  assert.equal(manager.agentCycle(run.id).phase,'await_action_verification');
  run=manager.completeStep(run.id,run.activeStepId,{verified:true,outcome:'success'});
  assert.equal(manager.agentCycle(run.id).phase,'ready_for_next_step');
  run=manager.completeRun(run.id);
  projected=manager.protocolTask(run.id);
  assert.equal(projected.status,'completed');
  assert.equal(projected.result.verifiedSteps,1);
  assert.equal(manager.agentCycle(run.id).recommendedOperation,'none');
});

test('failed and cancelled durable runs project to MCP task terminal states',async()=>{
  const {dir,manager}=await fixture();
  let failed=manager.start(manager.create({objective:'Fail projection',root:dir}).id);
  failed=manager.beginStep(failed.id,{route:'files.read',description:'read'});
  failed=manager.completeStep(failed.id,failed.activeStepId,{verified:false,outcome:'failed',note:'verification failed'});
  const failedProjection=manager.protocolTask(failed.id);
  assert.equal(failedProjection.status,'failed');
  assert.equal(failedProjection.error.code,-32603);
  let cancelled=manager.start(manager.create({objective:'Cancel projection',root:dir}).id);
  cancelled=manager.cancel(cancelled.id,'cancelled by owner');
  assert.equal(manager.protocolTask(cancelled.id).status,'cancelled');
});

