import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../dist/db.js';
import { TaskAuthorizationService } from '../dist/task-authorization.js';
import { IsolatedAgentService } from '../dist/isolated-agent.js';

function fixture() {
  const root=mkdtempSync(resolve(tmpdir(),'nhd-iso-'));
  const store=new Store(resolve(root,'test.sqlite'));
  const auth=new TaskAuthorizationService(store);
  const service=new IsolatedAgentService(store,auth,resolve(root,'exchange'));
  return { root,store,auth,service,cleanup(){try{store.db.close()}catch{}try{rmSync(root,{recursive:true,force:true})}catch{}} };
}

test('isolated status is explicit about provider/configuration and never claims host fallback', () => {
  const f=fixture();
  try {
    const s=f.service.status();
    assert.equal(s.provider,'windows-sandbox');
    assert.equal(typeof s.featureAvailable,'boolean');
    assert.equal(typeof s.configured,'boolean');
    assert.equal(typeof s.online,'boolean');
    assert.ok(String(s.exchangeRoot).includes('exchange'));
    assert.equal(s.desktopTransport.mode,'winapp-ui-workflow');
    assert.equal(s.desktopWorker.backend,'winapp-ui');
  } finally { f.cleanup(); }
});

test('offline isolated commands fail closed instead of falling back to host desktop', async () => {
  const f=fixture();
  try {
    if (f.service.status().online) return;
    await assert.rejects(f.service.ping(), /offline|fallback is forbidden/i);
  } finally { f.cleanup(); }
});

test('sensitive browser fields are blocked before command dispatch', async () => {
  const f=fixture();
  try {
    f.service.selectorCache.set('iso-password',{ expiresAt:Date.now()+60000, meta:{ selectorId:'iso-password',tag:'input',role:'textbox',name:'Password',text:'',type:'password',href:'' } });
    await assert.rejects(f.service.browserFill('iso-password','secret'), /Sensitive\/password\/file\/payment fields are blocked/i);
  } finally { f.cleanup(); }
});

test('ordinary commit click requires task-scoped authorization before dispatch', async () => {
  const f=fixture();
  try {
    f.service.selectorCache.set('iso-submit',{ expiresAt:Date.now()+60000, meta:{ selectorId:'iso-submit',tag:'button',role:'button',name:'Submit',text:'Submit',type:'submit',href:'',formAssociated:true } });
    await assert.rejects(f.service.browserClick('iso-submit'), /requires an active task-scoped moderate authorization/i);
  } finally { f.cleanup(); }
});

test('direct stdio protocol ready/response updates live transport state for browser/system lane', async () => {
  const f=fixture();
  try {
    f.service.transport={ exitCode:null, pid:12345 };
    f.service.transportReady=false;
    let resolvePending, rejectPending;
    const pendingResult=new Promise((resolve,reject)=>{ resolvePending=resolve; rejectPending=reject; });
    const timer=setTimeout(()=>rejectPending(new Error('unit timeout')),1000);
    f.service.transportPending.set('cmd-unit',{ resolve:resolvePending, reject:rejectPending, timer, startedAt:Date.now(), type:'system.ping' });
    const now=new Date().toISOString();
    f.service.consumeTransportChunk(JSON.stringify({kind:'ready',version:'0.3.3',sessionId:'sandbox-unit',at:now,busy:false,browser:{running:false},desktopWorker:{backend:'host-winapp-ui',active:false,guestRawUia:false}})+'\n'+JSON.stringify({kind:'response',id:'cmd-unit',ok:true,result:{pong:true}})+'\n');
    assert.deepEqual(await pendingResult,{pong:true});
    const status=f.service.status();
    assert.equal(status.online,true);
    assert.equal(status.agentVersion,'0.3.3');
    assert.equal(status.sessionId,'sandbox-unit');
    assert.equal(status.transport.mode,'winapp-stdio');
    assert.equal(status.transport.online,true);
    assert.equal(status.desktopTransport.mode,'winapp-ui-workflow');
    f.service.disposeTransport(new Error('unit cleanup'),false);
  } finally { f.cleanup(); }
});

test('transport failure rejects pending browser/system commands without replay', async () => {
  const f=fixture();
  try {
    let rejectPending;
    const pendingResult=new Promise((resolve,reject)=>{ rejectPending=reject; });
    const timer=setTimeout(()=>rejectPending(new Error('unit timeout')),1000);
    f.service.transportPending.set('cmd-no-replay',{ resolve:()=>{}, reject:rejectPending, timer, startedAt:Date.now(), type:'browser.click' });
    f.service.rejectTransportPending(new Error('transport exited; pending commands are not replayed'));
    await assert.rejects(pendingResult,/not replayed/i);
    assert.equal(f.service.transportPending.size,0);
  } finally { f.cleanup(); }
});

test('host desktop backend uses WinApp native UI workflow and binds selectors to Sandbox windows', () => {
  const host=readFileSync(resolve(process.cwd(),'src','isolated-agent.ts'),'utf8');
  for (const needle of [
    'winapp-ui-workflow',
    'WINAPP_UI_WORKFLOW_ID',
    'runWinAppUi',
    '["list-windows"]',
    '["search", q, "-w", windowId',
    '["inspect", "-w", windowId',
    '["screenshot", "-w", target.windowId',
    '["invoke", selectorId, "-w", windowId',
    '["set-value", selectorId, text, "-w", windowId',
    'desktopSelectorCache.set(`${windowId}:${selectorId}`',
    'Sensitive/password/payment fields are blocked in Isolated Agent.',
    'is not replayed automatically',
    'Host desktop fallback is forbidden'
  ]) assert.ok(host.includes(needle),`missing host WinApp UI contract: ${needle}`);
  assert.ok(!host.includes('sendBootstrapFile'),'legacy mapped-file desktop transport must be absent');
});

test('guest 0.3.3 keeps browser/system stdio but raw desktop UIA fails closed', () => {
  const agent=readFileSync(resolve(process.cwd(),'isolated-agent','agent.mjs'),'utf8');
  const setup=readFileSync(resolve(process.cwd(),'scripts','setup-isolated-agent.ps1'),'utf8');
  for (const needle of [
    "const VERSION = '0.3.3'",
    'Desktop UIA is routed by the host through WinApp UI workflow; guest raw-UIA fallback is disabled.',
    "function desktopSurfaceStatus(){return {backend:'host-winapp-ui',active:false,guestRawUia:false};}",
    'function startBootstrap() {',
    "writeFileHeartbeat('bootstrap')",
    'function startStdio() {',
    "process.stdin.setEncoding('utf8')",
    '--stdio',
    '--bootstrap',
    'const DEBUG_PORT = 9224',
    '--headless=new',
    'browser-profile-v2',
    "type==='browser.status'",
    "type==='browser.inspect'"
  ]) assert.ok(agent.includes(needle),`missing guest 0.3.3 contract: ${needle}`);
  assert.ok(!agent.includes("async function startStdio() {\n  await desktopBridge.start(12000);"),'stdio must not wait for raw desktop bridge');
  assert.ok(!agent.includes("async function startBootstrap() {\n  await startDesktopBridgeServer();"),'bootstrap must not start raw UIA worker');
  assert.ok(setup.includes('agent.mjs --bootstrap'));
});
