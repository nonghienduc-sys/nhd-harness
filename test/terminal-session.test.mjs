import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSessionManager, TerminalSessionError } from '../dist/terminal-session.js';

function clock(start=1_000_000) {
  let now=start;
  return {now:()=>now,advance:(ms)=>{now+=ms;}};
}

function manager(extra={}) {
  const c = extra.clock ?? clock();
  return {clock:c, manager:new TerminalSessionManager({roots:['D:/workspace','D:/projects'],maxSessions:2,ttlMs:60_000,maxHistory:3,allowedEnvironment:['NODE_ENV','PYTHONUTF8'],now:c.now,...extra})};
}

const hash = 'a'.repeat(64);

test('creates isolated session with random id and bounded cwd', () => {
  const {manager:m} = manager();
  const a=m.create('D:/workspace/app');
  const b=m.create('D:/projects/demo');
  assert.match(a.id,/^term-[a-f0-9]{32}$/);
  assert.notEqual(a.id,b.id);
  assert.equal(a.cwd,'D:\\workspace\\app');
  assert.equal(a.state,'open');
  assert.deepEqual(a.history,[]);
});

test('rejects cwd outside configured roots', () => {
  const {manager:m}=manager();
  assert.throws(()=>m.create('C:/Windows'),e=>e instanceof TerminalSessionError && e.code==='INVALID_CWD');
});

test('enforces active session limit', () => {
  const {manager:m}=manager();
  m.create('D:/workspace/a');
  m.create('D:/workspace/b');
  assert.throws(()=>m.create('D:/workspace/c'),e=>e instanceof TerminalSessionError && e.code==='SESSION_LIMIT');
});

test('only allowed environment variables can persist', () => {
  const {manager:m}=manager();
  const s=m.create('D:/workspace',{node_env:'test',PYTHONUTF8:'1'});
  assert.deepEqual(s.env,{NODE_ENV:'test',PYTHONUTF8:'1'});
  assert.throws(()=>m.setEnvironment(s.id,{PATH:'evil'}),e=>e instanceof TerminalSessionError && e.code==='ENV_BLOCKED');
  assert.throws(()=>m.setEnvironment(s.id,{NODE_ENV:'a\nb'}),e=>e instanceof TerminalSessionError && e.code==='ENV_BLOCKED');
});

test('beginStep requires SHA-256 identity and prevents concurrent steps', () => {
  const {manager:m}=manager();
  const s=m.create('D:/workspace');
  assert.throws(()=>m.beginStep(s.id,'bad'),/SHA-256/);
  const busy=m.beginStep(s.id,hash);
  assert.equal(busy.state,'busy');
  assert.equal(busy.activeStep.sequence,1);
  assert.throws(()=>m.beginStep(s.id,hash),e=>e instanceof TerminalSessionError && e.code==='BUSY');
});

test('verified successful step may update cwd inside root', () => {
  const {manager:m}=manager();
  const s=m.create('D:/workspace');
  const busy=m.beginStep(s.id,hash);
  const done=m.completeStep(s.id,{sequence:busy.activeStep.sequence,commandHash:hash,exitCode:0,verified:true,nextCwd:'D:/workspace/sub',stdoutChars:10});
  assert.equal(done.state,'open');
  assert.equal(done.cwd,'D:\\workspace\\sub');
  assert.equal(done.history[0].stateChanged,true);
  assert.equal(done.history[0].verified,true);
});

test('unverified or failed step never changes cwd and marks session failed', () => {
  const {manager:m}=manager();
  const s=m.create('D:/workspace');
  const busy=m.beginStep(s.id,hash);
  const failed=m.completeStep(s.id,{sequence:busy.activeStep.sequence,commandHash:hash,exitCode:1,verified:false,nextCwd:'D:/workspace/should-not-apply'});
  assert.equal(failed.state,'failed');
  assert.equal(failed.cwd,'D:\\workspace');
  assert.equal(failed.history[0].stateChanged,false);
  const reset=m.resetFailed(s.id);
  assert.equal(reset.state,'open');
});

test('step completion rejects mismatched sequence or command hash', () => {
  const {manager:m}=manager();
  const s=m.create('D:/workspace');
  const busy=m.beginStep(s.id,hash);
  assert.throws(()=>m.completeStep(s.id,{sequence:busy.activeStep.sequence+1,commandHash:hash,exitCode:0,verified:true}),e=>e instanceof TerminalSessionError && e.code==='STEP_MISMATCH');
  assert.equal(m.get(s.id).state,'busy');
});

test('history is bounded to newest entries', () => {
  const {manager:m}=manager();
  const s=m.create('D:/workspace');
  for(let i=0;i<5;i++){
    const h=String(i).padStart(64,String(i));
    const busy=m.beginStep(s.id,h);
    m.completeStep(s.id,{sequence:busy.activeStep.sequence,commandHash:h,exitCode:0,verified:true});
  }
  const view=m.get(s.id);
  assert.equal(view.history.length,3);
  assert.deepEqual(view.history.map(x=>x.sequence),[3,4,5]);
});

test('TTL expires idle open/failed sessions', () => {
  const c=clock();
  const {manager:m}=manager({clock:c,ttlMs:60_000});
  const s=m.create('D:/workspace');
  c.advance(60_001);
  assert.equal(m.get(s.id).state,'expired');
  assert.throws(()=>m.beginStep(s.id,hash),e=>e instanceof TerminalSessionError && e.code==='NOT_OPEN');
});

test('close is explicit and closed session cannot execute again', () => {
  const {manager:m}=manager();
  const s=m.create('D:/workspace');
  const closed=m.close(s.id);
  assert.equal(closed.state,'closed');
  assert.throws(()=>m.beginStep(s.id,hash),e=>e instanceof TerminalSessionError && e.code==='NOT_OPEN');
});

test('Emergency Stop invalidates all active sessions and blocks new ones until cleared', () => {
  const {manager:m}=manager();
  const a=m.create('D:/workspace/a');
  const b=m.create('D:/workspace/b');
  m.beginStep(a.id,hash);
  const invalidated=m.emergencyStop();
  assert.equal(invalidated,2);
  assert.equal(m.get(a.id).state,'closed');
  assert.equal(m.get(b.id).state,'closed');
  assert.throws(()=>m.create('D:/workspace/c'),e=>e instanceof TerminalSessionError && e.code==='EMERGENCY_STOP');
  m.clearEmergencyStop();
  assert.equal(m.create('D:/workspace/c').state,'open');
});
