import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../dist/db.js';
import { ExecutionLaneService } from '../dist/execution-lanes.js';
import { TaskRunManager } from '../dist/task-runtime.js';

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'nhd-lanes-'));
  const store = new Store(resolve(root, 'test.sqlite'));
  new TaskRunManager(store, { roots: [root] });
  const now = new Date().toISOString();
  const deadline = new Date(Date.now() + 3600_000).toISOString();
  const insertTask = store.db.prepare(
    "INSERT INTO agent_runs(id,objective,root,state,max_steps,max_runtime_ms,step_count,active_step_id,checkpoint_seq,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,0,NULL,0,?,?,?)"
  );
  for (const id of ['task-a', 'task-b', 'task-c', 'task-bg-1', 'task-bg-2', 'task-bg-3', 'task-bg-4', 'task-bg-5', 'task-bg-6', 'task-bg-extra', 'task-iso-1', 'task-iso-2']) {
    insertTask.run(id, `Fixture task ${id}`, root, 'running', 16, 3600_000, now, now, deadline);
  }
  const service = new ExecutionLaneService(store, resolve(root, 'exchange'));
  return { root, store, service, cleanup: () => { try { store.db.close(); } catch {} try { rmSync(root, { recursive:true, force:true }); } catch {} } };
}
const offline = { provider:'windows-sandbox', featureAvailable:false, configured:false, online:false };
const ready = { provider:'windows-sandbox', featureAvailable:true, configured:true, online:true };

test('auto routing keeps non-GUI work in Background and foreground/GUI work isolated', () => {
  const f=fixture();
  try {
    const bg=f.service.plan({ preferred:'auto', domain:'office', operation:'read' }, ready);
    assert.equal(bg.lane,'background');
    assert.equal(bg.hostForegroundAllowed,false);
    assert.match(bg.constraints.join(' '),/Never inject host mouse/i);
    const iso=f.service.plan({ preferred:'auto', domain:'desktop', operation:'navigate', requiresGui:true }, ready);
    assert.equal(iso.lane,'isolated');
    assert.equal(iso.available,true);
    assert.equal(iso.hostForegroundAllowed,false);
  } finally { f.cleanup(); }
});

test('Background refuses GUI-dependent steps instead of stealing host foreground', () => {
  const f=fixture();
  try { assert.throws(() => f.service.plan({ preferred:'background', domain:'desktop', operation:'navigate', requiresForeground:true }, ready), /cannot execute a foreground\/GUI-dependent step/i); }
  finally { f.cleanup(); }
});

test('Isolated route reports unavailable rather than falling back to host desktop', () => {
  const f=fixture();
  try {
    const plan=f.service.plan({ preferred:'isolated', domain:'browser', operation:'navigate', requiresGui:true }, offline);
    assert.equal(plan.lane,'isolated');
    assert.equal(plan.available,false);
    assert.match(plan.reason,/not ready/i);
  } finally { f.cleanup(); }
});

test('resource locks allow concurrent reads but reject write/exclusive conflicts', () => {
  const f=fixture();
  try {
    const a=f.service.acquireLock({ resource:'file:D:/project/report.docx', mode:'read', taskRunId:'task-a', lane:'background' });
    const b=f.service.acquireLock({ resource:'file:D:/project/report.docx', mode:'read', taskRunId:'task-b', lane:'isolated' });
    assert.ok(a.id && b.id);
    assert.throws(() => f.service.acquireLock({ resource:'file:D:/project/report.docx', mode:'write', taskRunId:'task-c', lane:'background' }), /Resource is busy/i);
    assert.equal(f.service.releaseLock(a.id,'task-a').released,true);
    assert.equal(f.service.releaseLock(b.id,'task-b').released,true);
    const c=f.service.acquireLock({ resource:'file:D:/project/report.docx', mode:'exclusive', taskRunId:'task-c', lane:'isolated' });
    assert.equal(c.mode,'exclusive');
  } finally { f.cleanup(); }
});

test('artifact handoff creates bounded task-scoped input/output folders', () => {
  const f=fixture();
  try {
    const h=f.service.createHandoff({ taskRunId:'task-example', fromLane:'background', toLane:'isolated' });
    assert.equal(h.state,'open');
    assert.equal(h.fromLane,'background');
    assert.equal(h.toLane,'isolated');
    assert.equal(existsSync(h.inputDir),true);
    assert.equal(existsSync(h.outputDir),true);
    assert.equal(f.service.completeHandoff(h.id).state,'completed');
  } finally { f.cleanup(); }
});


test('scheduler uses dynamic bounded Background capacity and one Isolated reservation', () => {
  const f=fixture();
  try {
    const cap=f.service.backgroundConcurrency;
    assert.ok(cap>=2 && cap<=6);
    const reservations=[];
    for(let i=0;i<cap;i++) reservations.push(f.service.reserve({taskRunId:`task-bg-${i+1}`,stepId:`step-${i+1}`,lane:'background'}));
    const iso=f.service.reserve({taskRunId:'task-iso-1',stepId:'step-iso',lane:'isolated'});
    assert.equal(f.service.listReservations('background').length,cap);
    assert.equal(f.service.listReservations('isolated').length,1);
    assert.throws(() => f.service.reserve({taskRunId:'task-bg-extra',lane:'background'}),new RegExp(`at capacity \\(${cap}\/${cap}\\)`,'i'));
    assert.throws(() => f.service.reserve({taskRunId:'task-iso-2',lane:'isolated'}),/at capacity \(1\/1\)/i);
    for(let i=0;i<reservations.length;i++) assert.equal(f.service.releaseReservation(reservations[i].id,`task-bg-${i+1}`).released,true);
    assert.equal(f.service.releaseReservation(iso.id,'task-iso-1').released,true);
  } finally { f.cleanup(); }
});
