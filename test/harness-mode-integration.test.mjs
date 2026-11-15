import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createWorkstationMcp} from '../dist/mcp.js';
import {createWorkstationRuntime} from '../dist/workstation-runtime.js';
import {Store} from '../dist/db.js';
import {TaskRunManager} from '../dist/task-runtime.js';
import {readBrainMode,writeBrainMode} from '../dist/brain-only.js';

async function connect(server,label) {
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 const client=new Client({name:label,version:'1'});
 await server.connect(serverTransport);
 await client.connect(clientTransport);
 return client;
}

test('remote/local connections share persisted Mode 2, enforce task authorization and block Mode 3 tools',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nhd-mode2-mcp-e2e-'));
 const before=process.env.NHD_BRAIN_MODE_FILE;
 const beforeFlag=process.env.NHD_BRAIN_ONLY;
 process.env.NHD_BRAIN_MODE_FILE=join(dir,'brain-mode.json');
 process.env.NHD_BRAIN_ONLY='1';
 let a=null,b=null,remote=null,local=null,store=null;
 try {
  writeBrainMode('harness');
  store=new Store(join(dir,'workstation.sqlite'));
  const taskRuns=new TaskRunManager(store,{roots:[dir]});
  const config={
   roots:[dir],intakeRoots:[],dataDir:dir,backupDir:join(dir,'backups'),
   writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,
   desktopEnabled:true,browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,
   ocrEnabled:true,emergencyStop:false,
  };
  const fail=()=>{throw Error('unexpected side effect');};
  const files={readWithMeta:()=>({redacted:false,text:'mode2-direct-read-ok'})};
  const terminal={preview:fail,execute:fail,cancel:fail,listRunning:()=>[]};
  const office={status:async()=>({companion:false,word:false,excel:false,powerpoint:false,outlook:false}),read:fail};
  const browser={status:async()=>({enabled:false,executable:null})};
  const desktop={status:async()=>({companion:false})};
  const pdf={status:async()=>({nativeTextExtraction:false})};
  const screen={status:async()=>({companion:false})};
  const intake={status:()=>({availableRoots:1})};
  const skills={validate:()=>({total:0,valid:0,enabled:0,skills:[]})};
  const runtime=createWorkstationRuntime({
   config,store,files,terminal,office,skills,screen,intake,pdf,desktop,browser,taskRuns,
   projects:{},documents:{},desktopIntake:{},
  });
  remote=createWorkstationMcp(runtime,{connectionKey:'remote-http|remote-mcp',brainOnly:true});
  local=createWorkstationMcp(runtime,{connectionKey:'local-http|local-harness',brainOnly:false});
  a=await connect(remote,'remote');
  b=await connect(local,'local');
  const status=await a.callTool({name:'harness_mode',arguments:{action:'status'}});
  assert.equal(status.structuredContent.mode,'harness');
  const denied=await a.callTool({name:'fs_read',arguments:{path:join(dir,'test.txt')}});
  assert.equal(denied.isError,true);
  assert.match(denied.content[0].text,/BRAIN_ONLY/);

  const created=await a.callTool({name:'task_run',arguments:{action:'create',objective:'Mode2 integration',root:dir,max_steps:10,max_runtime_minutes:20}});
  assert.ok(created.structuredContent.id,JSON.stringify(created));
  const id=created.structuredContent.id;
  const started=await a.callTool({name:'task_run',arguments:{action:'start',run_id:id}});
  assert.equal(started.structuredContent.state,'running');
  const beforeAuth=await a.callTool({name:'harness_mode',arguments:{action:'select',mode:'self',task_run_id:id,confirmed:true}});
  assert.equal(beforeAuth.isError,true);
  assert.match(beforeAuth.content[0].text,/HARNESS_MODE_TASK_AUTHORIZATION_REQUIRED/);

  const authorized=await a.callTool({name:'task_run',arguments:{action:'authorize',run_id:id,max_risk_level:'moderate',ttl_minutes:10}});
  assert.equal(authorized.structuredContent.active,true);
  const notConfirmed=await a.callTool({name:'harness_mode',arguments:{action:'select',mode:'self',task_run_id:id}});
  assert.equal(notConfirmed.isError,true);
  assert.match(notConfirmed.content[0].text,/HARNESS_MODE_CONFIRMATION_REQUIRED/);

  const enabled=await a.callTool({name:'harness_mode',arguments:{action:'select',mode:'self',task_run_id:id,confirmed:true}});
  assert.equal(enabled.structuredContent.verified,true);
  assert.equal(readBrainMode(),'self');
  const verified=await b.callTool({name:'harness_mode',arguments:{action:'verify',mode:'self'}});
  assert.equal(verified.structuredContent.matches,true);
  const directRead=await a.callTool({name:'fs_read',arguments:{path:join(dir,'test.txt')}});
  assert.equal(directRead.isError,undefined);
  assert.equal(directRead.structuredContent.text,'mode2-direct-read-ok');

  const detached=await b.callTool({name:'harness_mode',arguments:{action:'select',mode:'direct',task_run_id:id,confirmed:true}});
  assert.equal(detached.structuredContent.mode,'direct');
  const detachedRead=await a.callTool({name:'fs_read',arguments:{path:join(dir,'test.txt')}});
  assert.equal(detachedRead.isError,true);
  assert.match(detachedRead.content[0].text,/BRAIN_DETACHED/);

  const restored=await a.callTool({name:'harness_mode',arguments:{action:'select',mode:'harness',task_run_id:id,confirmed:true}});
  assert.equal(restored.structuredContent.mode,'harness');
  assert.equal(readBrainMode(),'harness');
  const deniedAgain=await a.callTool({name:'fs_read',arguments:{path:join(dir,'test.txt')}});
  assert.equal(deniedAgain.isError,true);
  assert.match(deniedAgain.content[0].text,/BRAIN_ONLY/);
 } finally {
  if(a)await a.close();
  if(b)await b.close();
  if(remote)await remote.close();
  if(local)await local.close();
  if(store)store.db.close();
  if(before===undefined)delete process.env.NHD_BRAIN_MODE_FILE;else process.env.NHD_BRAIN_MODE_FILE=before;
  if(beforeFlag===undefined)delete process.env.NHD_BRAIN_ONLY;else process.env.NHD_BRAIN_ONLY=beforeFlag;
  try { rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200}); }
  catch (e) { console.warn('Integration fixture cleanup deferred on Windows:', String(e?.code ?? e)); }
 }
});
