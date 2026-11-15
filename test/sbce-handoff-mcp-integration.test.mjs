import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createWorkstationMcp} from '../dist/mcp.js';
import {createWorkstationRuntime} from '../dist/workstation-runtime.js';
import {Store} from '../dist/db.js';
import {FileService} from '../dist/files.js';
import {TaskRunManager} from '../dist/task-runtime.js';
import {readBrainMode,writeBrainMode} from '../dist/brain-only.js';
const JOB='job-22222222-2222-4222-8222-222222222222';
const CONTENT='NHD_MODE1_TRUSTED_HOST_CANARY_OK\n';

test('Mode1 MCP Brain -> approved SBCE draft -> host FS preview/apply/readback',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nhd-sbce-mcp-host-'));
  const oldMode=process.env.NHD_BRAIN_MODE_FILE,oldFlag=process.env.NHD_BRAIN_ONLY;
  process.env.NHD_BRAIN_MODE_FILE=join(dir,'brain-mode.json');
  process.env.NHD_BRAIN_ONLY='1';
  let store,server,client;
  try{
    writeBrainMode('harness');
    store=new Store(join(dir,'workspace.sqlite'));
    const config={roots:[dir],intakeRoots:[],dataDir:dir,backupDir:join(dir,'backup'),
      writeEnabled:true,terminalEnabled:true,skillsEnabled:true,screenEnabled:true,
      desktopEnabled:true,browserEnabled:true,visualDesktopEnabled:true,intakeEnabled:true,
      ocrEnabled:true,emergencyStop:false};
    const files=new FileService(config,store);
    const taskRuns=new TaskRunManager(store,{roots:[dir]});
    let owner='',status='ready_for_review';
    const sbceExecutor={
      mode:'on',
      async request(method,path,body){
        if(path==='/jobs'){
          owner=body.owner;assert.equal(body.work_order.apply_mode,'apply_after_accept');
          return{id:JOB,owner,status};
        }
        if(path.endsWith('/status'))return{id:JOB,owner,status,applyMode:'apply_after_accept',
          review:{artifacts:{draft:'worker-draft'},checks:[{name:'L0',ok:true},{name:'L1',ok:true}]}};
        if(path.endsWith('/review')){
          assert.equal(body.owner,owner);assert.equal(body.decision,'accept');
          status='accepted';return{id:JOB,owner,status};
        }
        if(path.endsWith('/pull'))return{job_id:JOB,kind:'draft',offset:body.start_char??0,
          text:CONTENT.slice(body.start_char??0,(body.start_char??0)+(body.max_chars??8000)),
          total_chars:CONTENT.length,truncated:false};
        throw Error('Unexpected SBCE route '+path);
      }
    };
    const fail=()=>{throw Error('unused runtime service');};
    const runtime=createWorkstationRuntime({config,store,files,taskRuns,sbceExecutor,
      terminal:{preview:fail,execute:fail,cancel:fail,listRunning:()=>[]},
      office:{status:async()=>({companion:false})},
      skills:{validate:()=>({total:0,enabled:0,valid:0,skills:[]})},
      screen:{status:()=>({enabled:false})},intake:{status:()=>({availableRoots:1})},
      pdf:{status:async()=>({nativeTextExtraction:false})},desktop:{status:async()=>({companion:false})},
      projects:{},documents:{},desktopIntake:{},browser:{status:async()=>({enabled:false,executable:null})}});
    server=createWorkstationMcp(runtime,{connectionKey:'remote-http|mode1-handoff-integration',brainOnly:true});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    client=new Client({name:'mode1-mcp-handoff-test',version:'1'});
    await server.connect(serverTransport);await client.connect(clientTransport);
    const tools=await client.listTools();
    assert.ok(tools.tools.some(t=>t.name==='sbce_artifact_handoff'));
    const created=await client.callTool({name:'task_run',arguments:{action:'create',objective:'Mode1 real host apply integration',root:dir,max_steps:8,max_runtime_minutes:15}});
    const id=created.structuredContent.id;
    await client.callTool({name:'task_run',arguments:{action:'start',run_id:id}});
    const denied=await client.callTool({name:'fs_preview_write',arguments:{path:join(dir,'bad.txt'),content:'blocked',task_run_id:id}});
    assert.equal(denied.isError,true);
    assert.match(denied.content[0].text,/BRAIN_ONLY/);
    await client.callTool({name:'task_run',arguments:{action:'authorize',run_id:id,max_risk_level:'moderate',ttl_minutes:10}});
    const submitted=await client.callTool({name:'delegate_task',arguments:{action:'submit',task_run_id:id,work_order:{
      title:'Host handoff canary',kind:'shell_task',goal:'Produce one UTF-8 canary line for Windows host verified handoff',
      deliverables:['One single line'],acceptance:[{type:'rubric',text:'One line'}],risk:'low',
      apply_mode:'apply_after_accept',budget:{vnd:30,minutes:1,max_attempts:1}
    }}});
    assert.equal(submitted.structuredContent.id,JOB);
    const path=join(dir,'mode1-canary.txt');
    const rejected=await client.callTool({name:'sbce_artifact_handoff',arguments:{action:'preview',task_run_id:id,job_id:JOB,path}});
    assert.equal(rejected.isError,true);
    assert.match(rejected.content[0].text,/BRAIN_ACCEPTANCE_REQUIRED/);
    const accepted=await client.callTool({name:'review_pack',arguments:{action:'accept',task_run_id:id,job_id:JOB,note:'Brain reviewed deterministic canary'}});
    assert.equal(accepted.structuredContent.status,'accepted');
    const pending=await client.callTool({name:'sbce_artifact_handoff',arguments:{action:'preview',task_run_id:id,job_id:JOB,path}});
    assert.equal(pending.isError,undefined);
    assert.equal(existsSync(path),false);
    const applied=await client.callTool({name:'sbce_artifact_handoff',arguments:{action:'apply',task_run_id:id,
      action_id:pending.structuredContent.actionId,confirmation_token:pending.structuredContent.confirmationToken}});
    assert.equal(applied.structuredContent.verified,true);
    assert.equal(readFileSync(path,'utf8'),CONTENT);
    assert.equal(readBrainMode(),'harness');
    const repeat=await client.callTool({name:'sbce_artifact_handoff',arguments:{action:'apply',task_run_id:id,
      action_id:pending.structuredContent.actionId,confirmation_token:pending.structuredContent.confirmationToken}});
    assert.equal(repeat.isError,true);
  }finally{
    if(client)await client.close();if(server)await server.close();
    if(store)store.db.close();
    if(oldMode===undefined)delete process.env.NHD_BRAIN_MODE_FILE;else process.env.NHD_BRAIN_MODE_FILE=oldMode;
    if(oldFlag===undefined)delete process.env.NHD_BRAIN_ONLY;else process.env.NHD_BRAIN_ONLY=oldFlag;
    try{rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:150});}
    catch(e){console.warn('Temp fixture cleanup deferred',e.code);}
  }
});
