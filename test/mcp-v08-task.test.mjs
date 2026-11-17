import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkstationMcp } from './helpers/mcp-legacy.mjs';
import { Store } from '../dist/db.js';
import { TaskRunManager } from '../dist/task-runtime.js';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nhd-mcp-v08-task-'));
  const store=new Store(join(dir,'workstation.sqlite'));
  const taskRuns=new TaskRunManager(store,{roots:[dir],maxReferences:10,maxCheckpointHistory:10});
  let workstationCalls=0;
  const bomb=()=>{workstationCalls++;throw new Error('workstation service should not be called by task metadata tools');};
  const config={roots:[dir],intakeRoots:[],dataDir:dir,backupDir:join(dir,'backups'),writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,emergencyStop:false};
  const terminal={preview:bomb,execute:bomb,cancel:bomb,listRunning:()=>[]};
  const office={status:async()=>({companion:false,word:false,excel:false,powerpoint:false,outlook:false}),read:bomb,previewEdit:bomb,applyEdit:bomb,previewExport:bomb,applyExport:bomb,live:bomb,previewLiveEdit:bomb,applyLiveEdit:bomb};
  const browser={status:async()=>({enabled:true,executable:'C:/Browser/browser.exe'}),navigate:bomb,inspect:bomb,click:bomb,fill:bomb,wait:bomb,waitForCondition:bomb,screenshot:bomb};
  const desktop={status:async()=>({companion:true}),windows:bomb,inspect:bomb,action:bomb};
  const intake={status:()=>({availableRoots:1}),listRecent:bomb,waitForFile:bomb};
  const pdf={status:async()=>({nativeTextExtraction:true}),inspect:bomb,read:bomb,search:bomb,ocr:bomb,render:bomb};
  const skills={validate:()=>({total:0,valid:0,enabled:0,skills:[]}),list:bomb,search:bomb,get:bomb,activate:bomb,readResource:bomb};
  const screen={status:async()=>({companion:true}),list:bomb,capture:bomb,previewCapture:bomb,applyCapture:bomb};
  const files={}; const projects={}; const documents={}; const desktopIntake={};
  const terminalSessions={create:bomb,list:()=>[],status:bomb,setCwd:bomb,setEnvironment:bomb,resetFailed:bomb,close:bomb,preview:bomb,execute:bomb};
  const makeServer=()=>createWorkstationMcp(config,store,files,terminal,office,skills,screen,projects,documents,desktop,intake,pdf,desktopIntake,browser,terminalSessions,taskRuns);
  return {dir,store,taskRuns,config,makeServer,getWorkstationCalls:()=>workstationCalls};
}

async function connect(server){
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'v08-task-test',version:'1.0.0'});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('current MCP lists 70 tools when durable task runtime plus task adapters are injected',async()=>{
  const f=await fixture(); const server=f.makeServer(); const client=await connect(server);
  try{
    const listed=await client.listTools(); const names=listed.tools.map(x=>x.name);
    assert.equal(names.length,74);
    assert.ok(names.includes("harness_mode"));
    for(const name of ['task_run','task_run_step','task_run_reference','task_run_checkpoint','task_protocol_status','task_agent_cycle','fs_index_watch','local_ai_status','local_ai_route','local_ai_dispatch','local_ai_verify','tool_governor','project_rag_status','project_rag_query','project_rag_ingest']) assert.ok(names.includes(name)||server._nhdHiddenTools?.has(name),name);
  }finally{await client.close();await server.close();f.store.db.close();}
});

test('durable task state persists across separately created stateless MCP server instances',async()=>{
  const f=await fixture();
  const first=f.makeServer(); const c1=await connect(first); let runId;
  try{
    const created=await c1.callTool({name:'task_run',arguments:{action:'create',objective:'Prepare durable task',root:f.dir,max_steps:5,max_runtime_minutes:30}});
    assert.equal(created.isError,undefined);
    runId=created.structuredContent.id;
    const checkpoint=await c1.callTool({name:'task_run_checkpoint',arguments:{run_id:runId,summary:'Input located',next_action:'Inspect source'}});
    assert.equal(checkpoint.structuredContent.checkpoints.length,1);
    await c1.callTool({name:'task_run_reference',arguments:{run_id:runId,kind:'file',label:'Input file',location:join(f.dir,'input.docx'),fingerprint:'sha256:abc'}});
  }finally{await c1.close();await first.close();}

  const second=f.makeServer(); const c2=await connect(second);
  try{
    const status=await c2.callTool({name:'task_run',arguments:{action:'status',run_id:runId}});
    assert.equal(status.structuredContent.id,runId);
    assert.equal(status.structuredContent.state,'planned');
    assert.equal(status.structuredContent.checkpoints[0].summary,'Input located');
    assert.equal(status.structuredContent.references[0].label,'Input file');
  }finally{await c2.close();await second.close();f.store.db.close();}
});

test('task metadata tools never execute workstation services',async()=>{
  const f=await fixture(); const server=f.makeServer(); const client=await connect(server);
  try{
    const created=await client.callTool({name:'task_run',arguments:{action:'create',objective:'Metadata only',root:f.dir}}); const id=created.structuredContent.id;
    await client.callTool({name:'task_run_reference',arguments:{run_id:id,kind:'project',label:'Project',location:f.dir}});
    await client.callTool({name:'task_run_checkpoint',arguments:{run_id:id,summary:'Ready',next_action:'Plan route'}});
    const started=await client.callTool({name:'task_run',arguments:{action:'start',run_id:id}});
    assert.equal(started.structuredContent.state,'running');
    const begun=await client.callTool({name:'task_run_step',arguments:{action:'begin',run_id:id,route:'files.read',description:'Read metadata only'}});
    const stepId=begun.structuredContent.activeStepId;
    const completed=await client.callTool({name:'task_run_step',arguments:{action:'complete',run_id:id,step_id:stepId,verified:true,outcome:'success',receipt_id:'receipt-xyz'}});
    assert.equal(completed.structuredContent.steps[0].receiptId,'receipt-xyz');
    assert.equal(f.getWorkstationCalls(),0);
  }finally{await client.close();await server.close();f.store.db.close();}
});

test('confirmation-required task step is state-only and needs explicit confirmation transition',async()=>{
  const f=await fixture(); const server=f.makeServer(); const client=await connect(server);
  try{
    const created=await client.callTool({name:'task_run',arguments:{action:'create',objective:'Confirm metadata step',root:f.dir}}); const id=created.structuredContent.id;
    await client.callTool({name:'task_run',arguments:{action:'start',run_id:id}});
    const begun=await client.callTool({name:'task_run_step',arguments:{action:'begin',run_id:id,route:'terminal.preview-confirmed',description:'Command requires owner confirmation',requires_confirmation:true}});
    const stepId=begun.structuredContent.activeStepId;
    assert.equal(begun.structuredContent.state,'waiting_confirmation');
    const confirmed=await client.callTool({name:'task_run_step',arguments:{action:'confirm',run_id:id,step_id:stepId}});
    assert.equal(confirmed.structuredContent.state,'running');
    assert.equal(confirmed.structuredContent.steps[0].state,'running');
    assert.equal(f.getWorkstationCalls(),0);
  }finally{await client.close();await server.close();f.store.db.close();}
});

test('Emergency Stop blocks create/start/begin/confirm but allows recording completion of an already running step',async()=>{
  const f=await fixture(); const server=f.makeServer(); const client=await connect(server);
  try{
    const created=await client.callTool({name:'task_run',arguments:{action:'create',objective:'Emergency semantics',root:f.dir}}); const id=created.structuredContent.id;
    await client.callTool({name:'task_run',arguments:{action:'start',run_id:id}});
    const begun=await client.callTool({name:'task_run_step',arguments:{action:'begin',run_id:id,route:'browser.read',description:'Action already started'}}); const stepId=begun.structuredContent.activeStepId;
    f.config.emergencyStop=true;
    const blockedCreate=await client.callTool({name:'task_run',arguments:{action:'create',objective:'Blocked',root:f.dir}});
    assert.equal(blockedCreate.isError,true);
    const blockedBegin=await client.callTool({name:'task_run_step',arguments:{action:'begin',run_id:id,route:'files.read',description:'Blocked new action'}});
    assert.equal(blockedBegin.isError,true);
    const completed=await client.callTool({name:'task_run_step',arguments:{action:'complete',run_id:id,step_id:stepId,verified:true,outcome:'success',receipt_id:'receipt-before-stop'}});
    assert.equal(completed.isError,undefined);
    assert.equal(completed.structuredContent.steps[0].state,'verified');
  }finally{await client.close();await server.close();f.store.db.close();}
});


test('workstation health exposes task counts without durable task content',async()=>{
  const f=await fixture(); const server=f.makeServer(); const client=await connect(server);
  try{
    await client.callTool({name:'task_run',arguments:{action:'create',objective:'Sensitive business objective text',root:f.dir}});
    const health=await client.callTool({name:'workstation_health',arguments:{}});
    assert.equal(health.structuredContent.tasks.total,1);
    assert.equal(health.structuredContent.tasks.byState.planned,1);
    const serialized=JSON.stringify(health.structuredContent.tasks);
    assert.equal(serialized.includes('Sensitive business objective text'),false);
    assert.equal(serialized.includes('references'),false);
    assert.equal(serialized.includes('checkpoints'),false);
  }finally{await client.close();await server.close();f.store.db.close();}
});

