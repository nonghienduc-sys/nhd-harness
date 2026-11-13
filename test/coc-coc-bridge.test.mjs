import test from 'node:test';
import assert from 'node:assert/strict';
import { CocCocBridgeService } from '../dist/coc-coc-bridge.js';

function makeStore(run = null) {
  return {
    audit() {},
    db: {
      prepare(sql) {
        if (sql.includes('SELECT id,objective,state FROM agent_runs')) {
          return { get: (id) => run && id === run.id ? run : undefined };
        }
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }
    }
  };
}

function makeAuthorizer({ moderate = false, high = false } = {}) {
  return {
    allows(_runId, level) {
      if (level === 'high') return high;
      if (level === 'moderate') return moderate || high;
      return false;
    },
    active(runId) {
      if (!moderate && !high) return null;
      return { id:'grant-test', runId, maxRiskLevel: high ? 'high' : 'moderate', expiresAt:'2099-01-01T00:00:00.000Z', createdAt:'2026-01-01T00:00:00.000Z', active:true };
    }
  };
}

const pulse = (service, overrides = {}) => service.pulse({
  tabId: 7,
  windowId: 2,
  url: 'https://example.com/app',
  title: 'Example App',
  active: true,
  focused: true,
  visible: true,
  bridgeVersion: '0.3.0',
  ...overrides,
});

async function inspectFixture(service) {
  const inspectPromise = service.inspect('', 20, 7);
  const pulled = pulse(service);
  assert.equal(pulled.commands.length, 1);
  assert.equal(pulled.commands[0].type, 'inspect');
  service.resolveResult({
    id: pulled.commands[0].id,
    ok: true,
    result: {
      page: { title: 'Example App', url: 'https://example.com/app' },
      controls: [
        { selectorId:'cocsel-safe', tag:'button', role:'button', name:'Open menu', text:'Open menu', type:'button', href:'', value:'', disabled:false, formAssociated:false, download:false, bounds:null },
        { selectorId:'cocsel-search', tag:'input', role:'textbox', name:'Search', text:'', type:'text', href:'', value:'', disabled:false, formAssociated:true, download:false, bounds:null },
        { selectorId:'cocsel-password', tag:'input', role:'textbox', name:'Password', text:'', type:'password', href:'', value:'', disabled:false, formAssociated:true, download:false, bounds:null },
        { selectorId:'cocsel-submit', tag:'button', role:'button', name:'Submit', text:'Submit', type:'submit', href:'', value:'', disabled:false, formAssociated:true, download:false, bounds:null },
        { selectorId:'cocsel-send', tag:'button', role:'button', name:'Send', text:'', type:'button', href:'', value:'', disabled:false, formAssociated:false, download:false, bounds:null },
        { selectorId:'cocsel-delete', tag:'button', role:'button', name:'Delete draft', text:'Delete', type:'button', href:'', value:'', disabled:false, formAssociated:false, download:false, bounds:null },
        { selectorId:'cocsel-pay', tag:'button', role:'button', name:'Pay now', text:'Pay now', type:'button', href:'', value:'', disabled:false, formAssociated:false, download:false, bounds:null },
      ],
      total: 7,
      truncated: false,
    }
  });
  return inspectPromise;
}

async function roundTripClick(service, selectorId, taskRunId) {
  const clickPromise = service.click(selectorId, taskRunId);
  const pulled = pulse(service);
  assert.equal(pulled.commands.length, 1);
  assert.equal(pulled.commands[0].type, 'click');
  assert.equal(pulled.commands[0].payload.selectorId, selectorId);
  service.resolveResult({ id: pulled.commands[0].id, ok: true, result: { ok:true, selectorId } });
  return clickPromise;
}

test('Coc Coc bridge keeps safe navigation automatic and sensitive fields blocked', async () => {
  const service = new CocCocBridgeService(makeStore());
  pulse(service);
  assert.equal(service.status().connected, true);
  assert.equal(service.status().safetyPolicy, 'risk-based-task-scoped-v2');
  const inspected = await inspectFixture(service);
  assert.equal(inspected.controls.length, 7);

  await assert.rejects(service.fill('cocsel-password', 'secret'), /Sensitive .* field is blocked/i);
  assert.equal(service.assessClick('cocsel-safe').level, 'low');
  const clicked = await roundTripClick(service, 'cocsel-safe');
  assert.equal(clicked.ok, true);
  assert.equal(clicked.risk.level, 'low');
});

test('Send/Submit require a live moderate task authorization and then execute exactly once', async () => {
  const noAuth = new CocCocBridgeService(makeStore());
  pulse(noAuth);
  await inspectFixture(noAuth);
  assert.equal(noAuth.assessClick('cocsel-submit').level, 'moderate');
  assert.equal(noAuth.assessClick('cocsel-send').level, 'moderate');
  await assert.rejects(noAuth.click('cocsel-submit'), /requires an active task-scoped authorization/i);

  const run = { id:'task-form', objective:'Complete and submit the registration form', state:'running' };
  const service = new CocCocBridgeService(makeStore(run), makeAuthorizer({ moderate:true }));
  pulse(service);
  await inspectFixture(service);
  const clicked = await roundTripClick(service, 'cocsel-submit', run.id);
  assert.equal(clicked.ok, true);
  assert.equal(clicked.risk.level, 'moderate');
  assert.equal(clicked.taskAuthorization.runId, run.id);
  assert.equal(clicked.taskAuthorization.maxRiskLevel, 'moderate');
});

test('High-risk click requires high authorization plus matching durable-task objective', async () => {
  const wrongScope = { id:'task-edit', objective:'Edit the draft text and save it', state:'running' };
  const wrongService = new CocCocBridgeService(makeStore(wrongScope), makeAuthorizer({ high:true }));
  pulse(wrongService);
  await inspectFixture(wrongService);
  assert.equal(wrongService.assessClick('cocsel-delete').level, 'high');
  await assert.rejects(wrongService.click('cocsel-delete', wrongScope.id), /outside the durable task objective/i);

  const rightScope = { id:'task-delete', objective:'Delete the old draft after verifying it is obsolete', state:'running' };
  const service = new CocCocBridgeService(makeStore(rightScope), makeAuthorizer({ high:true }));
  pulse(service);
  await inspectFixture(service);
  const clicked = await roundTripClick(service, 'cocsel-delete', rightScope.id);
  assert.equal(clicked.ok, true);
  assert.equal(clicked.risk.level, 'high');
  assert.equal(clicked.risk.category, 'delete');
});

test('High-risk authorization does not silently cover payment when objective is unrelated', async () => {
  const run = { id:'task-delete', objective:'Delete the old draft', state:'running' };
  const service = new CocCocBridgeService(makeStore(run), makeAuthorizer({ high:true }));
  pulse(service);
  await inspectFixture(service);
  assert.equal(service.assessClick('cocsel-pay').category, 'payment');
  await assert.rejects(service.click('cocsel-pay', run.id), /outside the durable task objective/i);
});

test('Routine text fill still round-trips without task authorization', async () => {
  const service = new CocCocBridgeService(makeStore());
  pulse(service);
  await inspectFixture(service);
  const fillPromise = service.fill('cocsel-search', 'hello');
  const fillPulled = pulse(service);
  assert.equal(fillPulled.commands.length, 1);
  assert.equal(fillPulled.commands[0].type, 'fill');
  assert.equal(fillPulled.commands[0].payload.text, 'hello');
  service.resolveResult({ id: fillPulled.commands[0].id, ok: true, result: { ok:true, selectorId:'cocsel-search', characters:5, value:'hello' } });
  const filled = await fillPromise;
  assert.equal(filled.ok, true);
  assert.equal(filled.characters, 5);
});


test('Snapshot, wait, DOM action and screenshot commands round-trip through v2 bridge', async () => {
  const service = new CocCocBridgeService(makeStore());
  pulse(service, { bridgeVersion:'0.4.0' });
  const snapPromise = service.snapshot(7, 12000);
  let pulled = pulse(service, { bridgeVersion:'0.4.0' });
  assert.equal(pulled.commands[0].type, 'snapshot');
  service.resolveResult({ id:pulled.commands[0].id, ok:true, result:{ page:{url:'https://example.com/app'}, text:'Hello', headings:[], links:[] } });
  assert.equal((await snapPromise).text, 'Hello');

  const actionPromise = service.action({ action:'scroll', tabId:7, deltaY:600 });
  pulled = pulse(service, { bridgeVersion:'0.4.0' });
  assert.equal(pulled.commands[0].type, 'scroll');
  service.resolveResult({ id:pulled.commands[0].id, ok:true, result:{ok:true} });
  assert.equal((await actionPromise).risk.level, 'low');

  const waitPromise = service.waitFor({kind:'text',contains:'Ready'},7,1000);
  pulled = pulse(service, { bridgeVersion:'0.4.0' });
  assert.equal(pulled.commands[0].type, 'wait_for');
  service.resolveResult({ id:pulled.commands[0].id, ok:true, result:{ok:true,waitedMs:20} });
  assert.equal((await waitPromise).ok,true);

  const shotPromise = service.screenshot(7);
  pulled = pulse(service, { bridgeVersion:'0.4.0' });
  assert.equal(pulled.commands[0].type, 'screenshot');
  service.resolveResult({ id:pulled.commands[0].id, ok:true, result:{ dataUrl:'data:image/jpeg;base64,SGVsbG8=', page:{url:'https://example.com/app'}, tab:{tabId:7} } });
  const shot=await shotPromise;
  assert.equal(shot.mimeType,'image/jpeg');
  assert.equal(shot.data,'SGVsbG8=');
});

test('Tab management lists/opens automatically but destructive existing-tab navigation is task scoped', async () => {
  const service = new CocCocBridgeService(makeStore());
  pulse(service,{bridgeVersion:'0.4.0'});
  const listPromise=service.tabAction({action:'list'});
  let pulled=pulse(service,{bridgeVersion:'0.4.0'});
  assert.equal(pulled.commands[0].type,'browser_command');
  assert.equal(pulled.commands[0].payload.action,'list_tabs');
  service.resolveResult({id:pulled.commands[0].id,ok:true,result:{tabs:[{tabId:7,url:'https://example.com'}]}});
  assert.equal((await listPromise).tabs.length,1);
  await assert.rejects(service.tabAction({action:'close',tabId:7}),/requires an active task-scoped authorization/i);
});

test('Enter key is treated as possible commit and requires moderate task authorization', async () => {
  const service = new CocCocBridgeService(makeStore());
  pulse(service,{bridgeVersion:'0.4.0'});
  await assert.rejects(service.action({action:'press',tabId:7,key:'ENTER'}),/requires an active task-scoped authorization/i);
});



test('Canva semantic text edit uses dedicated edit_text command and exact bridge verification', async () => {
  const run={id:'task-canva',objective:'Edit Canva presentation text',state:'running'};
  const service=new CocCocBridgeService(makeStore(run),makeAuthorizer({moderate:true}));
  pulse(service,{url:'https://www.canva.com/design/TEST/edit',title:'Canva',bridgeVersion:'0.4.1'});
  const inspectPromise=service.inspect('Old title',20,7);
  let pulled=pulse(service,{url:'https://www.canva.com/design/TEST/edit',title:'Canva',bridgeVersion:'0.4.1'});
  service.resolveResult({id:pulled.commands[0].id,ok:true,result:{page:{title:'Canva',url:'https://www.canva.com/design/TEST/edit'},controls:[{selectorId:'cocsel-canva-title',tag:'div',role:'group',name:'Old title',text:'Old title',type:'',href:'',value:'',disabled:false,formAssociated:false,download:false,contentEditable:false,bounds:null}],total:1,truncated:false}});
  await inspectPromise;
  const editPromise=service.editText('cocsel-canva-title','HARNESS NHD',run.id);
  pulled=pulse(service,{url:'https://www.canva.com/design/TEST/edit',title:'Canva',bridgeVersion:'0.4.1'});
  assert.equal(pulled.commands[0].type,'edit_text');
  assert.equal(pulled.commands[0].payload.text,'HARNESS NHD');
  service.resolveResult({id:pulled.commands[0].id,ok:true,result:{ok:true,semantic:true,verified:true,value:'HARNESS NHD',strategy:'contenteditable-semantic-v2'}});
  const result=await editPromise;
  assert.equal(result.verified,true);
});
