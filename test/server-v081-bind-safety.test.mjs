import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Store } from '../dist/db.js';
import { TaskRunManager } from '../dist/task-runtime.js';

const serverPath=fileURLToPath(new URL('../dist/server.js',import.meta.url));
const projectRoot=fileURLToPath(new URL('..',import.meta.url));

function openManager(dataDir){
  const store=new Store(join(dataDir,'workstation.sqlite'));
  const manager=new TaskRunManager(store,{roots:['D:/']});
  return {store,manager};
}

async function occupyLoopbackPort(){
  const blocker=createServer();
  await new Promise((resolve,reject)=>{
    blocker.once('error',reject);
    blocker.listen(0,'127.0.0.1',resolve);
  });
  const address=blocker.address();
  assert.ok(address && typeof address==='object');
  return {blocker,port:address.port};
}

async function closeServer(server){
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}

async function waitExit(child,timeoutMs=15000){
  if(child.exitCode!=null)return child.exitCode;
  return await new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      child.off('exit',onExit);
      fn(value);
    };
    const onExit=code=>finish(resolve,code);
    const timer=setTimeout(()=>finish(reject,new Error('non-owner server did not exit after listener failure')),timeoutMs);
    child.once('exit',onExit);
    if(child.exitCode!=null)onExit(child.exitCode);
  });
}

test('process that fails before listener ownership never recovers or pauses durable tasks',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'nhd-v081-listener-safety-'));
  const before=openManager(dataDir);
  let run=before.manager.create({objective:'Listener ownership safety',root:'D:/ChatGPT-Workstation-MCP',maxRuntimeMs:60000});
  run=before.manager.start(run.id);
  run=before.manager.beginStep(run.id,{route:'terminal.preview-confirmed',description:'owned by the real runtime'});
  const runId=run.id;
  const stepId=run.activeStepId;
  before.store.db.close();

  const {blocker,port}=await occupyLoopbackPort();
  await writeFile(join(dataDir,'config.json'),JSON.stringify({host:'127.0.0.1',port,tunnelEnabled:false}),{encoding:'utf8'});
  const child=spawn(process.execPath,[serverPath],{
    cwd:projectRoot,
    windowsHide:true,
    stdio:['ignore','ignore','ignore'],
    env:{...process.env,WORKSTATION_MCP_LOCAL_ENABLED:'0',WORKSTATION_OPENAI_TUNNEL_ENABLED:'0',WORKSTATION_MCP_DATA_DIR:dataDir,WORKSTATION_COMPANION_SECRET:'v081-bind-safety-test'}
  });
  try{
    const exitCode=await waitExit(child);
    assert.notEqual(exitCode,0);
    const inspect=openManager(dataDir);
    try{
      const stillRunning=inspect.manager.get(runId);
      assert.equal(stillRunning.state,'running');
      assert.equal(stillRunning.activeStepId,stepId);
      assert.equal(stillRunning.steps.find(x=>x.id===stepId).state,'running');
    }finally{inspect.store.db.close();}
  }finally{
    if(child.exitCode==null)child.kill('SIGKILL');
    await closeServer(blocker);
  }
});
