import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PACKAGE_VERSION=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Store } from '../dist/db.js';
import { TaskRunManager } from '../dist/task-runtime.js';

const serverPath=fileURLToPath(new URL('../dist/server.js',import.meta.url));
const projectRoot=fileURLToPath(new URL('..',import.meta.url));

async function freePort(){
  return await new Promise((resolvePort,reject)=>{
    const s=net.createServer();
    s.once('error',reject);
    s.listen(0,'127.0.0.1',()=>{const a=s.address();const p=typeof a==='object'&&a?a.port:0;s.close(err=>err?reject(err):resolvePort(p));});
  });
}

async function waitHealth(port,timeoutMs=10000){
  const deadline=Date.now()+timeoutMs;
  let last;
  while(Date.now()<deadline){
    try{const r=await fetch(`http://127.0.0.1:${port}/api/health/live`);if(r.ok)return await r.json();}catch(e){last=e;}
    await new Promise(r=>setTimeout(r,100));
  }
  throw last??new Error('server health timeout');
}

async function startServer(dataDir){
  const port=await freePort();
  const child=spawn(process.execPath,[serverPath],{
    cwd:projectRoot,
    windowsHide:true,
    env:{...process.env,WORKSTATION_MCP_LOCAL_ENABLED:'0',WORKSTATION_OPENAI_TUNNEL_ENABLED:'0',WORKSTATION_MCP_PORT:String(port),WORKSTATION_MCP_DATA_DIR:dataDir,WORKSTATION_COMPANION_SECRET:'v08-test-secret'}
  });
  let stderr='';child.stderr?.on('data',d=>stderr+=d.toString());
  try{await waitHealth(port);return{child,port,stderr:()=>stderr};}
  catch(e){try{child.kill();}catch{};throw new Error(`${e instanceof Error?e.message:String(e)}\n${stderr}`);}
}

async function stopServer(child){
  if(child.exitCode!=null)return;
  child.kill();
  await Promise.race([
    new Promise(r=>child.once('exit',r)),
    new Promise(r=>setTimeout(r,2000))
  ]);
  if(child.exitCode==null)child.kill('SIGKILL');
}

function openManager(dataDir){
  const store=new Store(join(dataDir,'workstation.sqlite'));
  const manager=new TaskRunManager(store,{roots:['D:/']});
  return{store,manager};
}

test('real server startup recovers an in-flight durable task without replaying it',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nhd-v08-server-restart-'));
  const before=openManager(dataDir);
  let run=before.manager.create({objective:'Restart acceptance',root:'D:/ChatGPT-Workstation-MCP',maxRuntimeMs:60000});
  run=before.manager.start(run.id);
  run=before.manager.beginStep(run.id,{route:'terminal.preview-confirmed',description:'synthetic in-flight action'});
  const runId=run.id;const stepId=run.activeStepId;
  before.store.db.close();

  const server=await startServer(dataDir);
  try{
    const inspect=openManager(dataDir);
    try{
      const recovered=inspect.manager.get(runId);
      assert.equal(recovered.state,'paused');
      assert.equal(recovered.activeStepId,null);
      const step=recovered.steps.find(x=>x.id===stepId);
      assert.equal(step.state,'interrupted');
      assert.match(step.note,/runtime restarted/i);
      assert.match(step.note,/must not be replayed automatically/i);
    }finally{inspect.store.db.close();}
  }finally{await stopServer(server.child);}
});

test('real emergency endpoint pauses active task and disabling stop never auto-resumes it',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nhd-v08-server-emergency-'));
  const server=await startServer(dataDir);
  try{
    const writer=openManager(dataDir);
    let run;
    try{
      run=writer.manager.create({objective:'Emergency endpoint acceptance',root:'D:/ChatGPT-Workstation-MCP',maxRuntimeMs:60000});
      run=writer.manager.start(run.id);
      run=writer.manager.beginStep(run.id,{route:'browser.read',description:'synthetic active action'});
    }finally{writer.store.db.close();}
    const runId=run.id;const stepId=run.activeStepId;

    const on=await fetch(`http://127.0.0.1:${server.port}/api/emergency`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})});
    assert.equal(on.ok,true);
    assert.equal((await on.json()).emergencyStop,true);

    const inspectOn=openManager(dataDir);
    try{
      const paused=inspectOn.manager.get(runId);
      assert.equal(paused.state,'paused');
      assert.equal(paused.activeStepId,null);
      const step=paused.steps.find(x=>x.id===stepId);
      assert.equal(step.state,'interrupted');
      assert.match(step.note,/Emergency Stop enabled by owner/i);
      assert.match(step.note,/must not be replayed automatically/i);
    }finally{inspectOn.store.db.close();}

    const off=await fetch(`http://127.0.0.1:${server.port}/api/emergency`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})});
    assert.equal(off.ok,true);
    assert.equal((await off.json()).emergencyStop,false);

    const inspectOff=openManager(dataDir);
    try{
      const stillPaused=inspectOff.manager.get(runId);
      assert.equal(stillPaused.state,'paused');
      assert.equal(stillPaused.activeStepId,null);
      assert.equal(stillPaused.steps.find(x=>x.id===stepId).state,'interrupted');
    }finally{inspectOff.store.db.close();}
  }finally{await stopServer(server.child);}
});


test('real /api/health exposes the Governor Word COM equal-route policy',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nhd-v0183-health-governor-'));
  const server=await startServer(dataDir);
  try{
    const response=await fetch(`http://127.0.0.1:${server.port}/api/health`);
    assert.equal(response.ok,true);
    const health=await response.json();
    assert.equal(health.version,PACKAGE_VERSION);
    assert.equal(health.governor.available,true);
    assert.equal(health.governor.hiddenCapabilities,false);
    assert.equal(health.governor.directFastLanePreserved,true);
    assert.equal(health.governor.wordDirectPolicy.requiredWhenExpressible,false);
    assert.equal(health.governor.wordDirectPolicy.terminalFallback,'allowed-under-standard-terminal-policy');
    assert.equal(health.governor.wordDirectPolicy.fallbackTimeoutSeconds,null);
    assert.match(health.governor.wordDirectPolicy.staleSchemaCompatibility,/NHD_WORD_DIRECT_V1/);
  }finally{await stopServer(server.child);}
});




