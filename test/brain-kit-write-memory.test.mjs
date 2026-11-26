import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkstationMcp } from '../dist/mcp.js';
import { createWorkstationRuntime } from '../dist/workstation-runtime.js';
import { Store } from '../dist/db.js';
import { TaskRunManager } from '../dist/task-runtime.js';
import { writeBrainMode } from '../dist/brain-only.js';

async function connect(server, label) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: label, version: '1' });
  await server.connect(st);
  await client.connect(ct);
  return client;
}

test('private memory previews work across MCP servers without relaxing write guards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nhd-memory-cross-server-'));
  const previousMode = process.env.NHD_BRAIN_MODE_FILE;
  const previousFlag = process.env.NHD_BRAIN_ONLY;
  process.env.NHD_BRAIN_MODE_FILE = join(dir, 'brain-mode.json');
  process.env.NHD_BRAIN_ONLY = '0';
  let store, serverA, serverB, a, b;
  try {
    writeBrainMode('self');
    store = new Store(join(dir, 'workstation.sqlite'));
    const taskRuns = new TaskRunManager(store, { roots: [dir] });
    const config = {
      roots: [dir], intakeRoots: [], dataDir: dir, backupDir: join(dir, 'backups'),
      knowledgeLocalDir: join(dir, 'knowledge-local'), writeEnabled: true,
      terminalEnabled: true, skillsEnabled: true, screenEnabled: true,
      desktopEnabled: true, browserEnabled: true, visualDesktopEnabled: true,
      intakeEnabled: true, ocrEnabled: true, emergencyStop: false,
    };
    const pending = new Map();
    const applied = [];
    let applyCalls = 0;
    let expiresAt;
    const files = {
      preview(kind, args, taskId) {
        const actionId = randomUUID();
        const nonce = randomUUID();
        pending.set(actionId, { kind, args, taskId, nonce });
        return { actionId, confirmationToken: nonce, expiresAt };
      },
      apply(actionId, nonce, kind, taskId) {
        applyCalls++;
        const item = pending.get(actionId);
        assert.ok(item);
        assert.equal(item.nonce, nonce);
        assert.equal(item.kind, kind);
        assert.equal(item.taskId, taskId);
        pending.delete(actionId);
        applied.push(item.args.path);
        return { path: item.args.path, applied: true };
      },
      readWithMeta: () => ({ redacted: false, text: '' }),
    };
    const fail = () => { throw Error('unexpected side effect'); };
    const runtime = createWorkstationRuntime({
      config, store, files, taskRuns,
      terminal: { preview: fail, execute: fail, cancel: fail, listRunning: () => [] },
      office: { status: async () => ({}), read: fail },
      skills: { validate: () => ({ total: 0, valid: 0, enabled: 0, skills: [] }) },
      screen: { status: async () => ({}) }, intake: { status: () => ({ availableRoots: 1 }) },
      pdf: { status: async () => ({}) }, desktop: { status: async () => ({}) },
      browser: { status: async () => ({ enabled: false }) },
      projects: {}, documents: {}, desktopIntake: {},
    });
    serverA = createWorkstationMcp(runtime, { connectionKey: 'local-http|memory-a', brainOnly: false });
    serverB = createWorkstationMcp(runtime, { connectionKey: 'local-http|memory-b', brainOnly: false });
    a = await connect(serverA, 'memory-a');
    b = await connect(serverB, 'memory-b');
    const createTask = () => {
      const run = taskRuns.create({ objective: 'memory regression', root: dir, maxSteps: 10, maxRuntimeMs: 600000 });
      taskRuns.start(run.id);
      return run.id;
    };
    const taskId = createTask();
    const otherTaskId = createTask();
    const call = (client, args) => client.callTool({ name: 'tri_thuc', arguments: args });
    const preview = async (id) => {
      const r = await call(a, {
        op: 'write_memory', phase: 'preview', task_run_id: taskId,
        id, loai: 'feedback', mo_ta: 'Regression', noi_dung: 'Benign fixture',
      });
      assert.ok(!r.isError, JSON.stringify(r));
      const payload = r.structuredContent ?? JSON.parse(r.content[0].text);
      assert.ok(payload.actionId);
      return payload;
    };
    const apply = (client, p, tid = taskId) => call(client, {
      op: 'write_memory', phase: 'apply', task_run_id: tid,
      action_id: p.actionId, confirmation_token: p.confirmationToken,
    });
    const rejectBeforeApply = async (p, tid = taskId, expected = /Only private memory previews/) => {
      const before = applyCalls;
      const r = await apply(b, p, tid);
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, expected);
      assert.equal(applyCalls, before);
    };

    const first = await preview('cross-server');
    const success = await apply(b, first);
    assert.ok(!success.isError, JSON.stringify(success));
    assert.deepEqual(applied, [join(config.knowledgeLocalDir, 'memory', 'cross-server.md')]);
    await rejectBeforeApply(first);

    const foreign = files.preview('write', { path: join(dir, 'outside.txt'), content: 'fixture' }, taskId);
    await rejectBeforeApply(foreign);

    const wrongTask = await preview('wrong-task');
    await rejectBeforeApply(wrongTask, otherTaskId);
    assert.ok(!(await apply(b, wrongTask)).isError);

    expiresAt = new Date(Date.now() - 1000).toISOString();
    const expired = await preview('expired');
    await rejectBeforeApply(expired);
    expiresAt = undefined;

    const changedRoot = await preview('changed-root');
    const originalRoot = config.knowledgeLocalDir;
    config.knowledgeLocalDir = join(dir, 'other-knowledge');
    await rejectBeforeApply(changedRoot, taskId, /Unexpected write location/);
    config.knowledgeLocalDir = originalRoot;
    assert.ok(!(await apply(b, changedRoot)).isError);
    assert.equal(applyCalls, 3);
  } finally {
    if (a) await a.close();
    if (b) await b.close();
    if (serverA) await serverA.close();
    if (serverB) await serverB.close();
    if (store) store.db.close();
    if (previousMode === undefined) delete process.env.NHD_BRAIN_MODE_FILE;
    else process.env.NHD_BRAIN_MODE_FILE = previousMode;
    if (previousFlag === undefined) delete process.env.NHD_BRAIN_ONLY;
    else process.env.NHD_BRAIN_ONLY = previousFlag;
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.warn('Fixture cleanup deferred:', String(e?.code ?? e)); }
  }
});
