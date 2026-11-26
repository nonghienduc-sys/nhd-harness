import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CocCocBridgeService } from '../dist/coc-coc-bridge.js';

const bgSource = readFileSync(new URL('../browser-extension/chat-health/background.js', import.meta.url), 'utf8');
const domSource = readFileSync(new URL('../browser-extension/chat-health/dom-bridge.js', import.meta.url), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const makeTab = () => ({ id: 41, windowId: 1, url: 'https://example.test/hidden', title: 'Hidden', active: false, discarded: false, autoDiscardable: true });
const command = (id = 'coc-test') => ({ id, tabId: 41, type: 'snapshot', payload: { maxChars: 1000 } });
const success = message => ({ id: message.command.id, ok: true, result: { text: 'ok' } });

function fixture({ send = (_id, message) => success(message), tab = makeTab() } = {}) {
  const calls = [], responses = [], alarms = new Map();
  let nextResponse = null;
  let pulseResponse = [];
  const chrome = {
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} } },
    runtime: { onMessage: event(), onStartup: event(), onInstalled: event() },
    tabs: {
      onRemoved: event(), onUpdated: event(), onActivated: event(), onCreated: event(),
      query: async query => query.url ? [] : [{ ...tab }],
      get: async id => { assert.equal(id, tab.id); return { ...tab }; },
      update: async (id, changes) => { calls.push(['update', id, { ...changes }]); Object.assign(tab, changes); return { ...tab }; },
      sendMessage: async (id, message) => { calls.push(['sendMessage', id, message]); return send(id, message); },
      create: async opts => { calls.push(['create', { ...opts }]); return { ...tab, ...opts }; },
      captureVisibleTab: async () => { calls.push(['captureVisibleTab']); return 'data:image/jpeg;base64,AA=='; },
    },
    windows: { update: async (...args) => { calls.push(['windows.update', ...args]); } },
    scripting: { executeScript: async opts => { calls.push(['executeScript', opts.target.tabId, [...opts.files]]); } },
    alarms: {
      onAlarm: event(), get: async name => alarms.get(name),
      create: async (name, opts) => { alarms.set(name, opts); },
      clear: async name => alarms.delete(name),
    },
  };
  const fetch = async (url, opts) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(opts.body || '{}');
    if (path.endsWith('/next')) {
      if (nextResponse === null) return new Promise(() => {}); // inert startup long poll, no timers
      const value = nextResponse; nextResponse = null;
      return { ok: true, json: async () => ({ commands: value }) };
    }
    if (path.endsWith('/pulse')) return { ok: true, json: async () => ({ commands: pulseResponse }) };
    if (path.endsWith('/result')) responses.push(body);
    if (path.endsWith('/sync-tabs')) calls.push(['syncTabs', body]);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const ctx = vm.createContext({ chrome, fetch, setTimeout, clearTimeout, console, Date });
  vm.runInContext(bgSource, ctx);
  const run = code => vm.runInContext(code, ctx);
  const ready = async () => { await run('syncPending'); await new Promise(resolve => setImmediate(resolve)); };
  const execute = async cmd => {
    await ready();
    ctx.testCommand = cmd;
    await run('dispatchCommand(testCommand)');
    return responses.at(-1);
  };
  const poll = async cmds => {
    await ready();
    nextResponse = cmds;
    await run('pollOnce()');
    await run('Promise.all([...tabQueues.values()])');
    return responses.at(-1);
  };
  const pulse = async cmds => {
    await ready();
    pulseResponse = cmds;
    const listener = chrome.runtime.onMessage.listeners[0];
    const delivered = await new Promise(resolve => listener({ type: 'NHD_COC_COC_DOM_PULSE', payload: {} }, { tab }, resolve));
    return { delivered, finish: result => new Promise(resolve => listener({ type: 'NHD_COC_COC_DOM_RESULT', payload: result }, { tab }, resolve)) };
  };
  return { calls, responses, alarms, chrome, run, ready, execute, poll, pulse, tab };
}

test('next result is delivered via tabs.sendMessage to the inactive tab', async () => {
  const f = fixture();
  const result = await f.poll([command()]);
  assert.deepEqual(result, { id: 'coc-test', ok: true, result: { text: 'ok' } });
  const sent = f.calls.find(c => c[0] === 'sendMessage');
  assert.equal(sent[1], 41);
  assert.equal(sent[2].type, 'NHD_COC_COC_DOM_EXEC');
  assert.equal(sent[2].command.id, 'coc-test');
  assert.ok(f.calls.some(c => c[0] === 'syncTabs' && c[1].tabs[0].active === false));
});

test('missing receiver is re-injected once and sendMessage retries once', async () => {
  let count = 0;
  const f = fixture({ send: (_id, message) => {
    if (++count === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    return success(message);
  } });
  assert.equal((await f.execute(command())).ok, true);
  assert.equal(count, 2);
  assert.deepEqual(f.calls.filter(c => c[0] === 'executeScript'), [['executeScript', 41, ['dom-bridge.js']]]);
});

test('autoDiscardable is disabled while working and restored by the idle alarm', async () => {
  const f = fixture();
  await f.execute(command());
  assert.equal(f.tab.autoDiscardable, false);
  assert.deepEqual(f.calls.filter(c => c[0] === 'update').map(c => c[2]), [{ autoDiscardable: false }]);
  const alarm = f.alarms.get('nhd-coc-coc-discard:41');
  assert.ok(alarm.when >= Date.now() + 299000);
  // A fired one-shot alarm disappears from the Chrome alarm registry.
  f.alarms.delete('nhd-coc-coc-discard:41');
  f.chrome.alarms.onAlarm.listeners[0]({ name: 'nhd-coc-coc-discard:41' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.tab.autoDiscardable, true);
  assert.deepEqual(f.calls.filter(c => c[0] === 'update').at(-1)[2], { autoDiscardable: true });
});

test('pulse fallback protects the tab and releases it on result', async () => {
  const f = fixture();
  const { delivered, finish } = await f.pulse([command('pulse')]);
  assert.equal(delivered.commands[0].id, 'pulse');
  assert.equal(f.tab.autoDiscardable, false);
  await finish({ id: 'pulse', ok: true, result: { text: 'ok' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.run('pulseReleases.size'), 0);
  assert.equal(f.run('protectedTabs.get(41).count'), 0);
});
  
test('screenshot of a background tab refuses without activating or focusing any window', async () => {
  const f = fixture();
  const result = await f.execute({ ...command(), type: 'screenshot', payload: { tabId: 41 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /cần tab hiện.*snapshot\/inspect/);
  assert.equal(f.calls.filter(c => c[0] === 'update' || c[0] === 'windows.update' || c[0] === 'captureVisibleTab').length, 0);
});

test('create and navigate default inactive; explicit active requests are respected', async () => {
  const f = fixture();
  await f.execute({ ...command('create'), type: 'browser_command', payload: { action: 'create_tab', url: 'https://example.test/new' } });
  assert.equal(f.calls.find(c => c[0] === 'create')[1].active, false);
  await f.execute({ ...command('nav'), type: 'browser_command', payload: { action: 'navigate_tab', tabId: 41, url: 'https://example.test/next' } });
  assert.equal(f.calls.find(c => c[0] === 'update')[2].active, false);
  await f.execute({ ...command('create-active'), type: 'browser_command', payload: { action: 'create_tab', url: 'https://example.test/new', active: true } });
  assert.equal(f.calls.filter(c => c[0] === 'create').at(-1)[1].active, true);
  assert.equal(f.calls.some(c => c[0] === 'windows.update'), false);
});

test('discarded tab reports tab_sleeping and ambiguous send errors never replay', async () => {
  const asleep = fixture({ tab: { ...makeTab(), discarded: true } });
  assert.match((await asleep.execute(command())).error, /^tab_sleeping:/);
  assert.equal(asleep.calls.some(c => c[0] === 'sendMessage'), false);
  const ambiguous = fixture({ send: () => { throw new Error('Message port closed before a response was received.'); } });
  assert.match((await ambiguous.execute(command())).error, /^page_slow:/);
  assert.equal(ambiguous.calls.filter(c => c[0] === 'sendMessage').length, 1);
  assert.equal(ambiguous.calls.some(c => c[0] === 'executeScript'), false);
});

test('syncTabs alone keeps the tab available, nextCommands immediately wakes, and pulse cannot redeliver', async () => {
  const bridge = new CocCocBridgeService({ audit() {} });
  const tab = { tabId: 41, windowId: 1, url: 'https://example.test/hidden', title: 'Hidden', active: false };
  bridge.syncTabs({ tabs: [tab] });
  assert.ok(bridge.listTabs().some(t => t.tabId === 41));
  const start = Date.now();
  const pending = bridge.nextCommands({ timeoutMs: 5000 });
  const snapshot = bridge.snapshot(41, 2000);
  const { commands } = await pending;
  assert.ok(Date.now() - start < 1000);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].tabId, 41);
  assert.deepEqual(bridge.pulse({ ...tab, visible: false }).commands, []);
  bridge.resolveResult({ id: commands[0].id, ok: true, result: { text: 'ok' } });
  assert.equal((await snapshot).text, 'ok');
  const another = bridge.snapshot(41, 2000);
  const pulse = bridge.pulse(tab).commands;
  assert.equal(pulse.length, 1);
  assert.deepEqual(await bridge.nextCommands({ timeoutMs: 30 }), { commands: [] });
  bridge.resolveResult({ id: pulse[0].id, ok: true, result: { text: 'pulse' } });
  assert.equal((await another).text, 'pulse');
  bridge.syncTabs({ tabs: [] });
  assert.equal(bridge.listTabs().length, 0);
});

test('content script executes a duplicate pushed command only once, including a pulse fallback', async () => {
  let count = 0;
  const onMessage = event();
  const item = { id: 'dedupe', type: 'page_info', payload: {} };
  const docListeners = new Map();
  const document = { documentElement: { dataset: {}, scrollHeight: 0 }, title: 'Test', readyState: 'complete', visibilityState: 'hidden', addEventListener(name, fn) { docListeners.set(name, fn); }, hasFocus() { count++; return false; } };
  const ctx = vm.createContext({
    chrome: { runtime: { id: 'test-extension', onMessage, sendMessage: async message => message.type === 'NHD_COC_COC_DOM_PULSE' ? { commands: [item] } : {} } },
    document, location: { hostname: 'example.test', port: '', href: 'https://example.test/hidden' },
    window: { addEventListener() {} }, innerWidth: 100, innerHeight: 100, scrollX: 0, scrollY: 0,
    setTimeout() {}, setInterval() {}, Date,
  });
  vm.runInContext(domSource, ctx);
  assert.equal(onMessage.listeners.length, 1);
  const listener = onMessage.listeners[0];
  const invoke = () => new Promise(resolve => assert.equal(listener({ type: 'NHD_COC_COC_DOM_EXEC', command: item }, { id: 'test-extension' }, resolve), true));
  const results = await Promise.all([invoke(), invoke()]);
  assert.ok(results.every(r => r.ok && r.id === 'dedupe'));
  assert.equal(count, 1);
  // The document's focus is sampled by pulse itself once; the command must not sample again.
  docListeners.get('visibilitychange')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(count, 2);
  assert.equal(listener({ type: 'NHD_COC_COC_DOM_EXEC', command: item }, { id: 'different-extension' }, () => {}), false);
});
