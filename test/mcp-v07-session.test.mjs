import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkstationMcp } from './helpers/mcp-legacy.mjs';
import { TerminalSessionManager } from '../dist/terminal-session.js';
import { TerminalSessionCoordinator } from '../dist/terminal-session-coordinator.js';

function services(sharedSessions){
  const config={roots:['D:/'],intakeRoots:['D:/inbox'],dataDir:'D:/tmp',backupDir:'D:/tmp/backups',writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,desktopEnabled:true,browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,ocrEnabled:true,emergencyStop:false};
  const terminal={
    preview(command,cwd,timeoutSeconds,environment={}){
      const suffix=JSON.stringify(environment);
      return {actionId:'action-'+command,confirmationToken:'token-'+command,commandHash:'c'.repeat(64),cwd,timeoutSeconds:timeoutSeconds??120,risk:'normal',criticalConfirmation:null,environmentNames:Object.keys(environment).sort(),suffix};
    },
    async execute(actionId,commandHash,confirmationToken){
      if(!String(confirmationToken).startsWith('token-')) throw new Error('Invalid confirmation token.');
      return {runId:'run-1',pid:123,startedAt:'now',completedAt:'later',timedOut:false,truncated:false,stdout:'ok\n',stderr:'',code:0,signal:null};
    },
    cancel(){return {cancelled:true}},
    listRunning(){return []}
  };
  const office={status:async()=>({companion:true,word:false,excel:false,powerpoint:false,outlook:false})};
  const browser={status:async()=>({enabled:true,executable:'C:/Browser/browser.exe'})};
  const desktop={status:async()=>({companion:true})};
  const intake={status:()=>({availableRoots:1})};
  const pdf={status:async()=>({nativeTextExtraction:true})};
  const dummy={};
  const server=createWorkstationMcp(config,dummy,dummy,terminal,office,dummy,dummy,dummy,dummy,desktop,intake,pdf,dummy,browser,sharedSessions);
  return {server,config};
}

function shared(){
  const terminal={
    preview(command,cwd,timeoutSeconds,environment={}){return {actionId:'a-'+command,confirmationToken:'t-'+command,commandHash:'d'.repeat(64),cwd,risk:'normal',criticalConfirmation:null,environmentNames:Object.keys(environment).sort(),timeoutSeconds};},
    async execute(_actionId,_hash,token){if(!String(token).startsWith('t-'))throw new Error('Invalid confirmation token.');return {runId:'r',pid:1,startedAt:'s',completedAt:'e',timedOut:false,truncated:false,stdout:'ok',stderr:'',code:0,signal:null};}
  };
  const manager=new TerminalSessionManager({roots:['D:/'],ttlMs:60_000,maxSessions:4});
  return new TerminalSessionCoordinator(manager,terminal);
}

async function connect(server){
  const [ct,st]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'v07-test',version:'1'});
  await server.connect(st); await client.connect(ct);
  return client;
}

test('current MCP lists 65 tools (v0.24.15 facades) when process-scope terminal sessions are injected',async()=>{
  const coordinator=shared();
  const {server}=services(coordinator); const client=await connect(server);
  try{
    const listed=await client.listTools(); const names=listed.tools.map(x=>x.name);
    assert.equal(names.length,66);
    assert.ok(names.includes("harness_mode"));
    for(const name of ['terminal_session','terminal_session_preview','terminal_session_execute','project_rag_status','project_rag_query','project_rag_ingest']) assert.ok(names.includes(name)||server._nhdHiddenTools?.has(name),name);
  }finally{await client.close();await server.close();}
});

test('terminal session persists across separately created stateless MCP server instances',async()=>{
  const coordinator=shared();
  const first=services(coordinator).server; const c1=await connect(first);
  let sessionId;
  try{
    const created=await c1.callTool({name:'terminal_session',arguments:{action:'create',cwd:'D:/',environment:{PYTHONUTF8:'1'}}});
    assert.equal(created.isError,undefined);
    assert.deepEqual(created.structuredContent.environmentNames,['PYTHONUTF8']);
    assert.equal('env' in created.structuredContent,false);
    sessionId=created.structuredContent.id;
  }finally{await c1.close();await first.close();}

  const second=services(coordinator).server; const c2=await connect(second);
  try{
    const status=await c2.callTool({name:'terminal_session',arguments:{action:'status',session_id:sessionId}});
    assert.equal(status.structuredContent.id,sessionId);
    assert.equal(status.structuredContent.state,'open');
    assert.deepEqual(status.structuredContent.environmentNames,['PYTHONUTF8']);
  }finally{await c2.close();await second.close();}
});

test('session preview uses persistent context and execute advances verified sequence once',async()=>{
  const coordinator=shared(); const {server}=services(coordinator); const client=await connect(server);
  try{
    const created=await client.callTool({name:'terminal_session',arguments:{action:'create',cwd:'D:/',environment:{PYTHONUTF8:'1'}}});
    const id=created.structuredContent.id;
    const preview=await client.callTool({name:'terminal_session_preview',arguments:{session_id:id,command:"Write-Output 'ok'",timeout_seconds:10}});
    assert.deepEqual(preview.structuredContent.preview.environmentNames,['PYTHONUTF8']);
    const p=preview.structuredContent.preview;
    const executed=await client.callTool({name:'terminal_session_execute',arguments:{session_id:id,action_id:p.actionId,command_hash:p.commandHash,confirmation_token:p.confirmationToken}});
    assert.equal(executed.structuredContent.session.state,'open');
    assert.equal(executed.structuredContent.session.sequence,1);
    assert.equal(executed.structuredContent.session.history.length,1);
    assert.equal(executed.structuredContent.session.history[0].verified,true);
    assert.equal(executed.structuredContent.result.code,0);
  }finally{await client.close();await server.close();}
});

test('session execution failure is not retried and leaves session failed',async()=>{
  const coordinator=shared(); const {server}=services(coordinator); const client=await connect(server);
  try{
    const created=await client.callTool({name:'terminal_session',arguments:{action:'create',cwd:'D:/'}}); const id=created.structuredContent.id;
    const preview=await client.callTool({name:'terminal_session_preview',arguments:{session_id:id,command:'Get-Location'}}); const p=preview.structuredContent.preview;
    const failed=await client.callTool({name:'terminal_session_execute',arguments:{session_id:id,action_id:p.actionId,command_hash:p.commandHash,confirmation_token:'wrong'}});
    assert.equal(failed.isError,true);
    const status=await client.callTool({name:'terminal_session',arguments:{action:'status',session_id:id}});
    assert.equal(status.structuredContent.state,'failed');
    assert.equal(status.structuredContent.sequence,1);
    assert.equal(status.structuredContent.history.length,1);
    assert.equal(status.structuredContent.history[0].verified,false);
  }finally{await client.close();await server.close();}
});

