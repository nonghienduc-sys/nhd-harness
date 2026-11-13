import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { TaskRunManager, TaskRunError } from '../dist/task-runtime.js';
import { DesktopService } from '../dist/desktop.js';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'nhd-capability-'));
  const store=new Store(join(dir,'workstation.sqlite'));
  const tasks=new TaskRunManager(store,{roots:[dir]});
  const run=tasks.start(tasks.create({objective:'Send one approved prompt to Antigravity',root:dir,maxRuntimeMs:60*60_000}).id);
  return {dir,store,tasks,run};
}

test('capability lease is app/action scoped, count bounded and hard-deny cannot be leased',async()=>{
  const {tasks,run}=await fixture();
  assert.throws(()=>tasks.grantCapability(run.id,{appScope:'Antigravity',actions:['send'],maxCount:1,ttlMinutes:10}),e=>e instanceof TaskRunError&&e.code==='AUTHORIZATION_REQUIRED');
  tasks.authorize(run.id,{maxRiskLevel:'moderate',ttlMinutes:30});
  const lease=tasks.grantCapability(run.id,{appScope:'Antigravity',actions:['send'],maxCount:1,ttlMinutes:10});
  assert.match(lease.id,/^lease-/);
  assert.equal(lease.remainingCount,1);
  assert.equal(tasks.authorizations.allowsCapability(run.id,'Antigravity - Workspace','send'),true);
  assert.equal(tasks.authorizations.allowsCapability(run.id,'Notepad','send'),false);
  assert.throws(()=>tasks.grantCapability(run.id,{appScope:'Antigravity',actions:['payment'],maxCount:1,ttlMinutes:10}),/hard-denied/i);
  const use=tasks.authorizations.consumeCapability(run.id,'Antigravity - Workspace','send');
  assert.match(use.useId,/^use-/);
  assert.equal(use.remainingCount,0);
  assert.equal(tasks.authorizations.allowsCapability(run.id,'Antigravity - Workspace','send'),false);
  assert.throws(()=>tasks.authorizations.consumeCapability(run.id,'Antigravity - Workspace','send'),/No active capability lease/);
});

test('high capability needs high general authorization and revoke is explicit',async()=>{
  const {tasks,run}=await fixture();
  tasks.authorize(run.id,{maxRiskLevel:'moderate',ttlMinutes:30});
  assert.throws(()=>tasks.grantCapability(run.id,{appScope:'Antigravity',actions:['delete'],maxCount:1,ttlMinutes:10}),e=>e instanceof TaskRunError&&e.code==='AUTHORIZATION_REQUIRED');
  tasks.authorize(run.id,{maxRiskLevel:'high',ttlMinutes:30});
  const lease=tasks.grantCapability(run.id,{appScope:'Antigravity',actions:['delete'],maxCount:2,ttlMinutes:10});
  assert.equal(tasks.listCapabilities(run.id).length,1);
  const revoked=tasks.revokeCapability(run.id,lease.id);
  assert.equal(revoked.revoked,1);
  assert.equal(tasks.listCapabilities(run.id).length,0);
});

test('DesktopService uses send lease for draft presence and consumes exactly once on Send',async()=>{
  const {store,tasks,run}=await fixture();
  tasks.authorize(run.id,{maxRiskLevel:'moderate',ttlMinutes:30});
  tasks.grantCapability(run.id,{appScope:'Antigravity',actions:['send'],maxCount:1,ttlMinutes:10});
  const config={emergencyStop:false,desktopEnabled:true,visualDesktopEnabled:false,screenPort:39102,companionSecret:'test-secret'};
  const desktop=new DesktopService(config,store,tasks.authorizations);
  const originalFetch=globalThis.fetch;
  const actions=[];
  globalThis.fetch=async(url,init={})=>{
    assert.equal(init.headers['x-workstation-companion-secret'],'test-secret');
    if(String(url).endsWith('/ui/windows')) return new Response(JSON.stringify({windows:[{windowId:'100',title:'Antigravity - Workspace',processId:1,automationId:'',className:'Window',controlType:'Window'},{windowId:'200',title:'Notepad',processId:2,automationId:'',className:'Window',controlType:'Window'}]}),{status:200,headers:{'content-type':'application/json'}});
    if(String(url).endsWith('/ui/inspect')){
      const body=JSON.parse(init.body); const ant=body.windowId==='100';
      const controls=ant?[
        {selectorId:'ui-input',windowId:'100',name:'Ask anything',automationId:'prompt',className:'Edit',controlType:'Edit',enabled:true,offscreen:false,password:false,depth:1,bounds:null},
        {selectorId:'ui-send',windowId:'100',name:'Send',automationId:'send',className:'Button',controlType:'Button',enabled:true,offscreen:false,password:false,depth:1,bounds:null},
        {selectorId:'ui-pass',windowId:'100',name:'Password',automationId:'password',className:'Edit',controlType:'Edit',enabled:true,offscreen:false,password:true,depth:1,bounds:null}
      ]:[{selectorId:'ui-other-send',windowId:'200',name:'Send',automationId:'send',className:'Button',controlType:'Button',enabled:true,offscreen:false,password:false,depth:1,bounds:null}];
      return new Response(JSON.stringify({windowId:body.windowId,controls,total:controls.length,truncated:false}),{status:200,headers:{'content-type':'application/json'}});
    }
    if(String(url).endsWith('/ui/action')){ const body=JSON.parse(init.body); actions.push(body); return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}}); }
    throw new Error(`Unexpected URL ${url}`);
  };
  try{
    await desktop.windows();
    await desktop.inspect('100');
    const draft=await desktop.action({action:'set_text',selectorId:'ui-input',text:'Upgrade Harness NHD',taskRunId:run.id});
    assert.equal(draft.capabilityLease.remainingCount,1,'draft must not consume Send');
    assert.equal(actions.at(-1).approval.mode,'presence');
    assert.equal(actions.at(-1).approval.category,'send');
    const sent=await desktop.action({action:'invoke',selectorId:'ui-send',taskRunId:run.id});
    assert.equal(sent.capabilityLease.remainingCount,0);
    assert.match(sent.capabilityUseId,/^use-/);
    assert.equal(actions.at(-1).approval.mode,'consume');
    assert.throws(()=>tasks.authorizations.consumeCapability(run.id,'Antigravity - Workspace','send'),/No active capability lease/);
    await assert.rejects(()=>desktop.action({action:'invoke',selectorId:'ui-send',taskRunId:run.id}),/requires an active capability lease/);
    await assert.rejects(()=>desktop.action({action:'set_text',selectorId:'ui-pass',text:'secret',taskRunId:run.id}),/hard-denied/);
    tasks.grantCapability(run.id,{appScope:'Antigravity',actions:['send'],maxCount:1,ttlMinutes:10});
    await desktop.inspect('200');
    await assert.rejects(()=>desktop.action({action:'invoke',selectorId:'ui-other-send',taskRunId:run.id}),/requires an active capability lease scoped to app 'Notepad'/);
    await assert.rejects(()=>desktop.action({action:'click_point',windowId:'100',xRatio:0.5,yRatio:0.5,taskRunId:run.id}),/coordinate clicks remain blocked/);
  } finally { globalThis.fetch=originalFetch; }
});

test('Electron companion capability policy validates HMAC binding/replay and hard-deny',async()=>{
  const { createRequire }=await import('node:module');
  const { createHmac }=await import('node:crypto');
  const require=createRequire(import.meta.url);
  const { createDesktopCapabilityPolicy }=require('../electron/desktop-capability-policy.cjs');
  const secret='policy-test-secret';
  const policy=createDesktopCapabilityPolicy(secret);
  const now=Date.now();
  const makeProof=(control,mode,useId=null)=>{
    const proof={version:'desktop-capability-v1',leaseId:'lease-1',runId:'task-1',app:'Antigravity - Workspace',category:'send',mode,windowId:control.windowId,selectorId:control.selectorId,useId,expiresAt:new Date(now+10*60_000).toISOString(),issuedAt:new Date(now).toISOString()};
    const fields=[proof.version,proof.leaseId,proof.runId,proof.app,proof.category,proof.mode,proof.windowId,proof.selectorId,proof.useId??'',proof.expiresAt,proof.issuedAt];
    return {...proof,signature:createHmac('sha256',secret).update(fields.join('\n'),'utf8').digest('hex')};
  };
  const input={selectorId:'ui-input',windowId:'100',name:'Ask anything',automationId:'prompt',className:'Edit',controlType:'Edit',password:false};
  const send={selectorId:'ui-send',windowId:'100',name:'Send',automationId:'send',className:'Button',controlType:'Button',password:false};
  const password={selectorId:'ui-pass',windowId:'100',name:'Password',automationId:'password',className:'Edit',controlType:'Edit',password:true};
  const payment={selectorId:'ui-pay',windowId:'100',name:'Pay now',automationId:'pay',className:'Button',controlType:'Button',password:false};
  assert.deepEqual(policy.classifyControl(input,'set_text'),{blocked:false,category:'send',mode:'presence'});
  assert.deepEqual(policy.classifyControl(send,'invoke'),{blocked:false,category:'send',mode:'consume'});
  assert.equal(policy.classifyControl(password,'set_text').blocked,true);
  assert.equal(policy.classifyControl(payment,'invoke').blocked,true);
  const presence=makeProof(input,'presence');
  assert.equal(policy.verifyApproval(presence,input,'send','presence',now),true);
  assert.throws(()=>policy.verifyApproval({...presence,signature:'0'.repeat(64)},input,'send','presence',now),/signature check failed/);
  assert.throws(()=>policy.verifyApproval(presence,{...input,selectorId:'other'},'send','presence',now),/different selector\/window/);
  const consumed=makeProof(send,'consume','use-1');
  assert.equal(policy.verifyApproval(consumed,send,'send','consume',now),true);
  assert.throws(()=>policy.verifyApproval(consumed,send,'send','consume',now),/already consumed/);
});
