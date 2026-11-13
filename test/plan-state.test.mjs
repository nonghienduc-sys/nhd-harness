import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { TaskRunManager, TaskRunError } from '../dist/task-runtime.js';
import { PlanStateService } from '../dist/plan-state.js';
import { WorkspaceContextService } from '../dist/workspace-memory.js';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nhd-plan-state-'));
  const dbPath=join(dir,'workstation.sqlite');
  const store=new Store(dbPath);
  const tasks=new TaskRunManager(store,{roots:[dir]});
  const plans=new PlanStateService(store,tasks);
  tasks.setCompletionGuard((id)=>plans.taskCompletionGuard(id));
  return {dir,dbPath,store,tasks,plans};
}

const phases=[
  {key:'p1',title:'Foundation'},
  {key:'p2',title:'Integration'},
  {key:'p3',title:'Verification'},
];

test('multi-phase plan persists ordered state and auto-advances only after verification',async()=>{
  const {dir,plans}=await fixture();
  let plan=plans.create({kind:'upgrade',title:'MCP upgrade',root:dir,phases});
  assert.equal(plan.state,'planned');
  assert.equal(plan.percent,0);
  assert.equal(plan.currentPhase,null);
  assert.equal(plan.nextPhase.key,'p1');

  plan=plans.start(plan.id);
  assert.equal(plan.state,'running');
  assert.equal(plan.currentPhase.key,'p1');
  assert.equal(plan.currentPhase.state,'running');

  plan=plans.verifyPhase(plan.id,'p1',{summary:'Foundation verified'});
  assert.equal(plan.percent,33);
  assert.equal(plan.phases[0].state,'verified');
  assert.equal(plan.currentPhase.key,'p2');
  assert.equal(plan.currentPhase.state,'running');
  assert.equal(plan.state,'running');

  plan=plans.verifyPhase(plan.id,'p2',{summary:'Integration verified'});
  assert.equal(plan.currentPhase.key,'p3');
  assert.equal(plan.state,'running');
  plan=plans.verifyPhase(plan.id,'p3',{summary:'All checks passed'});
  assert.equal(plan.state,'completed');
  assert.equal(plan.percent,100);
  assert.equal(plan.currentPhase,null);
});

test('parent durable task cannot complete while its bound required plan phases remain',async()=>{
  const {dir,tasks,plans}=await fixture();
  let run=tasks.start(tasks.create({objective:'Upgrade runtime',root:dir}).id);
  let plan=plans.create({kind:'upgrade',title:'Runtime upgrade',root:dir,taskRunId:run.id,phases});
  plan=plans.start(plan.id);
  assert.throws(()=>tasks.completeRun(run.id),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE'&&/cannot complete/i.test(e.message));
  plan=plans.verifyPhase(plan.id,'p1');
  assert.throws(()=>tasks.completeRun(run.id),e=>e instanceof TaskRunError&&e.code==='INVALID_STATE');
  plan=plans.verifyPhase(plan.id,'p2');
  plan=plans.verifyPhase(plan.id,'p3');
  run=tasks.completeRun(run.id);
  assert.equal(run.state,'completed');
});

test('blocked phase is visible and resumes the exact phase without skipping ahead',async()=>{
  const {dir,plans}=await fixture();
  let plan=plans.start(plans.create({kind:'workflow',title:'Blocked workflow',root:dir,phases}).id);
  plan=plans.blockPhase(plan.id,'p1','Waiting for dependency');
  assert.equal(plan.state,'blocked');
  assert.equal(plan.currentPhase.key,'p1');
  assert.equal(plan.currentPhase.state,'blocked');
  assert.equal(plan.nextPhase.key,'p2');
  plan=plans.resume(plan.id);
  assert.equal(plan.state,'running');
  assert.equal(plan.currentPhase.key,'p1');
  assert.equal(plan.currentPhase.state,'running');
});

test('plan state survives service recreation without relying on chat context',async()=>{
  const {dir,dbPath,store,plans}=await fixture();
  let plan=plans.start(plans.create({kind:'upgrade',title:'Persistent plan',root:dir,phases}).id);
  plan=plans.verifyPhase(plan.id,'p1',{summary:'done'});
  const id=plan.id;
  store.db.close();
  const store2=new Store(dbPath);
  const tasks2=new TaskRunManager(store2,{roots:[dir]});
  const plans2=new PlanStateService(store2,tasks2);
  const restored=plans2.get(id);
  assert.equal(restored.percent,33);
  assert.equal(restored.currentPhase.key,'p2');
  assert.equal(restored.phases[0].summary,'done');
  store2.db.close();
});

test('optional trailing phases do not prevent required-plan completion',async()=>{
  const {dir,plans}=await fixture();
  let plan=plans.start(plans.create({kind:'general',title:'Optional tail',root:dir,phases:[{key:'required',title:'Required'},{key:'optional',title:'Optional',required:false}]}).id);
  plan=plans.verifyPhase(plan.id,'required');
  assert.equal(plan.state,'completed');
  assert.equal(plan.percent,100);
  assert.equal(plan.phases.find(p=>p.key==='optional').state,'skipped');
});


test('context bootstrap exposes the durable current plan phase as resume authority',async()=>{
  const {dir,store,tasks,plans}=await fixture();
  const root=dir;
  const projects={
    status(input){if(input!==root)throw new Error('missing project');return{projectId:'p1',name:'MCP',root,type:'software',stateDir:root+'.nhd',updatedAt:new Date().toISOString(),documents:0,decisions:[],unresolved:0,currentEdit:null,lastQa:null};},
    readMemory(){return{section:'memory',text:''};},
    listDecisions(){return[];},
    syncWorkspaceCheckpoint(){return{synced:true};},
  };
  const memory=new WorkspaceContextService({dataDir:dir},projects,tasks,{planState:plans});
  memory.checkpoint(root,{summary:'Plan created',objective:'Architecture upgrade'});
  let plan=plans.create({kind:'upgrade',title:'Architecture upgrade',root,phases});
  plan=plans.start(plan.id);
  plan=plans.verifyPhase(plan.id,'p1',{summary:'foundation verified'});
  const restored=memory.bootstrap(root,{mode:'progressive'});
  assert.equal(restored.phasePlan.id,plan.id);
  assert.equal(restored.phasePlan.currentPhase.key,'p2');
  assert.match(restored.resumeState.nextAction,/Integration/);
  memory.close();store.db.close();
});
