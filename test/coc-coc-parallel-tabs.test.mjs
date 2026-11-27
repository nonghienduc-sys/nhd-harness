import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/db.js';
import { TaskRunManager } from '../dist/task-runtime.js';
import { TaskAuthorizationService } from '../dist/task-authorization.js';
import { CocCocBridgeService } from '../dist/coc-coc-bridge.js';
import { runWithTaskContext } from '../dist/resource-guard.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nhd-parallel-tabs-'));
  const store = new Store(join(root, 'locks.sqlite'));
  t.after(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const runs = new TaskRunManager(store, { roots: [root] });
  const auth = new TaskAuthorizationService(store);
  const bridge = new CocCocBridgeService(store, auth);
  function task(name) {
    const run = runs.start(runs.create({ objective: name, root }).id);
    auth.authorize(run.id, 'moderate');
    return run.id;
  }
  const a = task('Task A');
  const b = task('Task B');
  const url = 'https://example.test/page';
  const tabs = [{ tabId: 1, url, title: 'Transport', active: true }];
  const calls = [];
  let nextId = 100;
  let failOpen = false;
  bridge.syncTabs({ tabs });

  // Replace only the browser wire transport; all policy, selector and SQLite
  // locking paths run through the real bridge and task lifecycle.
  bridge.issue = async (tabId, type, payload) => {
    calls.push({ tabId, type, payload });
    if (type === 'browser_command' && payload.action === 'create_tab') {
      const during = locks().find(l => l.resource === 'browser:coccoc:tab:new');
      assert.equal(during?.owner_kind, 'ephemeral');
      assert.match(during.task_run_id, /^ephemeral:/);
      if (failOpen) return { ok: false, error: 'Injected transport failure' };
      const tab = { tabId: nextId++, url: payload.url, title: 'Task tab', active: false };
      tabs.push(tab);
      bridge.syncTabs({ tabs });
      return { ok: true, result: { tab } };
    }
    if (type === 'inspect') {
      return { ok: true, result: { controls: [{
        selectorId: 'selector-' + tabId, tag: 'button', role: 'button',
        type: 'button', name: 'Open menu', text: 'Open menu'
      }] } };
    }
    if (type === 'click') return { ok: true, result: { ok: true } };
    if (type === 'browser_command' && payload.action === 'navigate_tab') {
      return { ok: true, result: { tab: { tabId: payload.tabId, url: payload.url } } };
    }
    throw new Error('Unexpected fake transport request: ' + type);
  };

  function locks() {
    return store.db.prepare(
      'SELECT resource, task_run_id, owner_kind, mode FROM execution_resource_locks ORDER BY resource'
    ).all();
  }
  const open = (id) => bridge.tabAction({ action: 'open', url, taskRunId: id });
  const openInContext = (id) => runWithTaskContext({ taskRunId: id, ephemeralOwnerId: 'ephemeral:op:outer' }, () =>
    bridge.tabAction({ action: 'open', url }));
  return { a, b, bridge, runs, locks, open, openInContext, calls, url, fail: () => { failOpen = true; } };
}

test('hai tac vu mo tab song song', async t => {
  const f = fixture(t);
  const first = await f.open(f.a);
  const second = await f.openInContext(f.b);
  assert.notEqual(first.tab.tabId, second.tab.tabId);
  assert.equal(f.runs.get(f.a).state, 'running');
  assert.equal(f.runs.get(f.b).state, 'running');
  assert.equal(f.calls.filter(c => c.payload.action === 'create_tab').length, 2);
});

test('tac vu A khong thao tac duoc tab cua B', async t => {
  const f = fixture(t);
  await f.open(f.a);
  const { tab } = await f.open(f.b);
  const inspected = await f.bridge.inspect('', 10, tab.tabId);
  const selector = inspected.controls[0].selectorId;
  const before = f.calls.length;
  const busy = /Resource is busy: browser:coccoc:tab:\d+ is locked by task/;
  await assert.rejects(f.bridge.click(selector, f.a), busy);
  await assert.rejects(f.bridge.tabAction({ action: 'navigate', tabId: tab.tabId, url: f.url, taskRunId: f.a }), busy);
  assert.equal(f.calls.length, before);
  assert.equal((await f.bridge.click(selector, f.b)).ok, true);
});

test('khoa tab:new duoc nha ngay sau khi mo', async t => {
  const f = fixture(t);
  await f.openInContext(f.a);
  assert.ok(!f.locks().some(l => l.resource === 'browser:coccoc:tab:new'));
  f.fail();
  await assert.rejects(f.openInContext(f.b), /Injected transport failure/);
  assert.ok(!f.locks().some(l => l.resource === 'browser:coccoc:tab:new'));
});

test('tab vua mo thuoc tac vu da mo no', async t => {
  const f = fixture(t);
  const { tab } = await f.openInContext(f.a);
  const lock = f.locks().find(l => l.resource === 'browser:coccoc:tab:' + tab.tabId);
  assert.equal(lock?.task_run_id, f.a);
  assert.equal(lock?.owner_kind, 'task');
  assert.equal(lock?.mode, 'write');
});

test('tac vu ket thuc thi nha khoa tab cua no', async t => {
  const f = fixture(t);
  const { tab } = await f.open(f.a);
  const key = 'browser:coccoc:tab:' + tab.tabId;
  assert.ok(f.locks().some(l => l.resource === key && l.task_run_id === f.a));
  f.runs.completeRun(f.a);
  assert.ok(!f.locks().some(l => l.resource === key && l.task_run_id === f.a));
  const result = await f.bridge.tabAction({ action: 'navigate', tabId: tab.tabId, url: f.url, taskRunId: f.b });
  assert.equal(result.tab.tabId, tab.tabId);
  assert.ok(f.locks().some(l => l.resource === key && l.task_run_id === f.b));
});
