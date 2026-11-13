import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkstationMcp } from './helpers/mcp-legacy.mjs';
import { Store } from '../dist/db.js';
import { FileService } from '../dist/files.js';
import { ProjectService } from '../dist/project.js';
import { TaskRunManager } from '../dist/task-runtime.js';
import { WorkspaceContextService } from '../dist/workspace-memory.js';

async function connect(server){
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'project-per-task-test',version:'1.0.0'});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('MCP rootless task create auto-creates project and external artifact stays bound after another project becomes active', async () => {
  const dir=await mkdtemp(join(tmpdir(),'nhd-mcp-project-per-task-'));
  const backupDir=join(dir,'backups');
  const projectWorkspaceRoot=join(dir,'NHD Projects');
  await mkdir(backupDir,{recursive:true});
  const config={
    roots:[dir],intakeRoots:[],dataDir:join(dir,'data'),backupDir,projectWorkspaceRoot,
    writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,
    browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,emergencyStop:false
  };
  await mkdir(config.dataDir,{recursive:true});
  const store=new Store(join(dir,'workstation.sqlite'));
  const files=new FileService(config,store);
  const projects=new ProjectService(config,store,files);
  const taskRuns=new TaskRunManager(store,{roots:[dir],maxReferences:20,maxCheckpointHistory:20});
  const workspaceMemory=new WorkspaceContextService(config,projects,taskRuns);
  const bomb=()=>{throw new Error('unexpected workstation action');};
  const terminal={preview:bomb,execute:bomb,cancel:bomb,listRunning:()=>[]};
  const office={status:async()=>({companion:false,word:false,excel:false,powerpoint:false,outlook:false}),read:bomb,previewEdit:bomb,applyEdit:bomb,previewExport:bomb,applyExport:bomb,live:bomb,previewLiveEdit:bomb,applyLiveEdit:bomb};
  const skills={validate:()=>({total:0,valid:0,enabled:0,skills:[]}),list:bomb,search:bomb,get:bomb,activate:bomb,readResource:bomb};
  const screen={status:async()=>({companion:false}),list:bomb,capture:bomb,previewCapture:bomb,applyCapture:bomb};
  const desktop={status:async()=>({companion:false}),windows:bomb,inspect:bomb,action:bomb};
  const intake={status:()=>({availableRoots:0}),listRecent:bomb,waitForFile:bomb};
  const pdf={status:async()=>({nativeTextExtraction:true}),inspect:bomb,read:bomb,search:bomb,ocr:bomb,render:bomb};
  const browser={status:async()=>({enabled:false,executable:null}),navigate:bomb,inspect:bomb,click:bomb,fill:bomb,wait:bomb,waitForCondition:bomb,screenshot:bomb};
  const terminalSessions={create:bomb,list:()=>[],status:bomb,setCwd:bomb,setEnvironment:bomb,resetFailed:bomb,close:bomb,preview:bomb,execute:bomb};
  const documents={}; const desktopIntake={};

  const server=createWorkstationMcp(config,store,files,terminal,office,skills,screen,projects,documents,desktop,intake,pdf,desktopIntake,browser,terminalSessions,taskRuns,workspaceMemory);
  const client=await connect(server);
  try{
    const first=await client.callTool({name:'task_run',arguments:{action:'create',objective:'First managed project'}});
    assert.equal(first.isError,undefined);
    assert.equal(first.structuredContent.project.autoCreated,true);
    const firstRoot=first.structuredContent.root;
    assert.equal(firstRoot.startsWith(projectWorkspaceRoot),true);
    assert.equal((await stat(firstRoot)).isDirectory(),true);
    assert.equal((await stat(join(firstRoot,'.nhd-project.json'))).isFile(),true);
    assert.equal((await stat(join(firstRoot,'.nhd-task.json'))).isFile(),true);

    const external=join(dir,'outside-project.docx');
    await writeFile(external,'fixture','utf8');
    const bound=await client.callTool({name:'task_run_reference',arguments:{run_id:first.structuredContent.id,kind:'file',label:'External source',location:external}});
    assert.equal(bound.structuredContent.projectBinding.root,firstRoot);

    const second=await client.callTool({name:'task_run',arguments:{action:'create',objective:'Second managed project'}});
    assert.notEqual(second.structuredContent.root,firstRoot);

    const routed=await client.callTool({name:'context_working_state',arguments:{path:external,operation:'edit_again',status:'verified',source:'integration_test'}});
    assert.equal(routed.structuredContent.root,firstRoot);
  }finally{
    await client.close();
    await server.close();
    workspaceMemory.close();
    store.db.close();
  }
});
