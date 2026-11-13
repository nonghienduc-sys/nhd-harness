import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PACKAGE_VERSION=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceContextService } from '../dist/workspace-memory.js';

function fakeProjects(root) {
  return {
    status(input) {
      if (input !== root) throw new Error('Project has not been initialized.');
      return { projectId:'project-1', name:'NHD Workstation MCP', root, type:'software', stateDir:root + '.nhd', updatedAt:'2026-09-16T00:00:00.000Z', documents:0, decisions:[], unresolved:0, currentEdit:null, lastQa:null };
    },
    readMemory(input) {
      if (input !== root) throw new Error('Project has not been initialized.');
      return { section:'memory', text:'# Legacy memory\nProduction version: v0.9.0.\nChatGPT sees 52/75 tools.' };
    },
    listDecisions() { return []; },
  };
}

test('structured facts supersede stale legacy facts and persist across service instances', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-consolidation-'));
  const root = join(dataDir, 'project');
  const projects = fakeProjects(root);
  const first = new WorkspaceContextService({ dataDir }, projects, undefined, { maxFactHistory: 20 });
  first.checkpoint(root, {
    summary: 'Runtime validation completed.',
    objective: 'Second-brain memory consolidation',
    facts: [
      { key:'runtime.version', value:'v0.9.2', category:'runtime', confidence:'verified', source:'workstation_health' },
      { key:'connector.visible_tools', value:'75/75', category:'runtime', confidence:'verified', source:'tool_inventory' },
    ],
  });
  first.checkpoint(root, {
    summary: 'Runtime upgraded.',
    facts: [{ key:'runtime.version', value:'v0.9.3', category:'runtime', confidence:'verified', source:'workstation_health' }],
  });
  assert.equal(first.stats().facts >= 4, true);
  assert.equal(first.stats().factEvents >= 5, true);
  first.close();

  const second = new WorkspaceContextService({ dataDir }, projects, undefined, { maxFactHistory: 20 });
  const restored = second.bootstrap();
  const releaseFacts = restored.facts.filter((fact) => fact.key === 'runtime.version');
  assert.equal(releaseFacts.length, 1);
  assert.equal(releaseFacts[0].value, 'v0.9.3');
  assert.equal(restored.facts.find((fact) => fact.key === 'connector.visible_tools').value, '75/75');
  assert.equal(restored.memory.includes('runtime.version = v0.9.3'), true);
  assert.equal(restored.memory.includes('Production version: v0.9.0.'), true);
  assert.equal(restored.memory.indexOf('runtime.version = v0.9.3') < restored.memory.indexOf('Production version: v0.9.0.'), true);
  assert.equal(restored.runtimeVersion, PACKAGE_VERSION);
  assert.equal(restored.memory.includes(`runtime.package_version = ${PACKAGE_VERSION}`), true);
  assert.deepEqual(restored.consolidation.precedence, ['live_runtime_package','active_durable_task','structured_facts','latest_semantic_checkpoint','legacy_project_memory']);
  second.close();
});

test('legacy connector fact markers are consolidated and stripped from checkpoint text', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-markers-'));
  const root = join(dataDir, 'project');
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  service.checkpoint(root, { summary:'Validation passed. [[fact:runtime.version=v0.9.2]] [[fact:connector.visible_tools=75/75]]' });
  const restored = service.bootstrap();
  assert.equal(restored.checkpoint.summary, 'Validation passed.');
  assert.equal(restored.facts.find((fact) => fact.key === 'runtime.version').value, 'v0.9.2');
  assert.equal(restored.facts.find((fact) => fact.key === 'connector.visible_tools').value, '75/75');
  service.close();
});

test('structured facts reject credential-like material', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-fact-secret-'));
  const root = join(dataDir, 'project');
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  assert.throws(() => service.checkpoint(root, { summary:'safe', facts:[{ key:'runtime.secret', value:'api_key=abcdefghijklmnop' }] }), /credentials or secret material/i);
  service.close();
});


test('operational checkpoint never overwrites semantic objective or resume next action', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-operational-'));
  const root = join(dataDir, 'project');
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  const semantic = service.checkpoint(root, {
    kind:'semantic',
    summary:'Editing the project submission document.',
    objective:'Finish the project submission document.',
    nextAction:'Review the final Word formatting.',
    facts:[{key:'work.topic',value:'submission',category:'work'}],
  });
  const operational = service.checkpoint(root, {
    kind:'operational',
    summary:'Chat Health handoff marker.',
    objective:'Move to a fresh tab.',
    nextAction:'Open a new chat.',
  });
  const restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.checkpoint.sequence, semantic.sequence);
  assert.equal(restored.checkpoint.kind, 'semantic');
  assert.equal(restored.operationalCheckpoint.sequence, operational.sequence);
  assert.equal(restored.facts.find((fact) => fact.key === 'workspace.current_objective').value, 'Finish the project submission document.');
  assert.equal(restored.facts.find((fact) => fact.key === 'workspace.next_action').value, 'Review the final Word formatting.');
  assert.match(restored.resumePrompt, /Review the final Word formatting/);
  assert.doesNotMatch(restored.resumePrompt, /Next: Open a new chat/);
  service.close();
});

test('working document memory is bounded and relevance recall returns matching state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-working-'));
  const root = join(dataDir, 'project');
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  service.checkpoint(root, { summary:'Started Word formatting.', objective:'Format Máº«u 02', nextAction:'Run visual QA.' });
  service.recordWorkingState(root, {
    application:'word',
    path:join(root,'01_HO_SO','thuyet_minh.docx'),
    operation:'word_format',
    status:'verified',
    qa:'visual_review_completed',
    artifact:join(root,'01_HO_SO','qa.pdf'),
    source:'test',
  });
  const restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.workingState['working.current_document.application'], 'word');
  assert.match(restored.workingState['working.current_document.path'], /thuyet_minh\.docx/);
  const recalled = service.recall(root, 'Word format visual QA thuyet_minh', 10);
  assert.ok(recalled.results.some((item) => /working|word_format|thuyet_minh/i.test(item.text)));
  assert.ok(restored.recentEvents.some((event) => event.eventType === 'working_state'));
  service.close();
});


test('migrates the pre-v0.11 checkpoint schema without losing semantic checkpoints', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-migration-'));
  const root = join(dataDir, 'project');
  const db = new DatabaseSync(join(dataDir, 'workspace-memory.sqlite'));
  db.exec('CREATE TABLE workspace_checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL, sequence INTEGER NOT NULL, summary TEXT NOT NULL, next_action TEXT NOT NULL, objective TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(root,sequence));');
  db.prepare('INSERT INTO workspace_checkpoints(root,sequence,summary,next_action,objective,created_at) VALUES(?,?,?,?,?,?)').run(root,1,'Old semantic work','Continue old work','Real project objective','2026-09-18T00:00:00.000Z');
  db.close();
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  const restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.checkpoint.kind, 'semantic');
  assert.equal(restored.checkpoint.summary, 'Old semantic work');
  const schema = new DatabaseSync(join(dataDir, 'workspace-memory.sqlite'));
  const columns = schema.prepare('PRAGMA table_info(workspace_checkpoints)').all().map((row) => row.name);
  assert.ok(columns.includes('kind'));
  schema.close();
  service.close();
});

test('semantic checkpoint clears stale workspace.next_action when the new checkpoint has no next action', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-clear-next-'));
  const root = join(dataDir, 'project');
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  service.checkpoint(root, { summary:'Work in progress.', objective:'Finish work', nextAction:'Do the old next step.' });
  const second = service.checkpoint(root, { summary:'Work completed.', objective:'Finish work' });
  const restored = second.bootstrap;
  assert.equal(restored.facts.some((fact) => fact.key === 'workspace.next_action'), false);
  assert.doesNotMatch(restored.resumePrompt, /Do the old next step/);
  assert.match(restored.resumePrompt, /No active task or next action is currently recorded/);
  service.close();
});

test('freshness policy expires stale runtime, Office, browser and current-document state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-freshness-'));
  const root = join(dataDir, 'project');
  let now = Date.parse('2026-09-26T00:00:00.000Z');
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), undefined, { now: () => now });
  service.checkpoint(root, {
    summary:'Captured transient environment state.',
    facts:[
      { key:'runtime.version', value:'v0.11.1', category:'runtime', confidence:'verified' },
      { key:'office_live.word.status', value:'online', category:'runtime', confidence:'verified' },
      { key:'browser.active_page', value:'forms', category:'runtime', confidence:'verified' },
      { key:'working.current_document.path', value:join(root,'draft.docx'), category:'working_state', confidence:'verified' },
    ],
  });
  let restored = service.bootstrap(root, { activate:false });
  const byKey = new Map(restored.facts.map((fact) => [fact.key, fact]));
  assert.equal(byKey.get('runtime.version').freshnessClass, 'environment');
  assert.equal(byKey.get('office_live.word.status').freshnessClass, 'environment');
  assert.equal(byKey.get('browser.active_page').freshnessClass, 'environment');
  assert.equal(byKey.get('working.current_document.path').freshnessClass, 'session');
  now += 9 * 60 * 60_000;
  restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.facts.some((fact) => ['runtime.version','office_live.word.status','browser.active_page','working.current_document.path'].includes(fact.key)), false);
  assert.ok(restored.reconciliation.actions.some((action) => action.startsWith('expire:')));
  service.close();
});

test('reconciler moves terminal current task to last_task and leaves no active current_task', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-task-transition-'));
  const root = join(dataDir, 'project');
  const completedRun = {
    id:'task-done', objective:'Finish memory fix', root, state:'completed', maxSteps:3, maxRuntimeMs:1000,
    stepCount:1, activeStepId:null, checkpointSequence:0, createdAt:'2026-09-26T00:00:00.000Z',
    updatedAt:'2026-09-26T00:01:00.000Z', deadlineAt:'2026-09-26T01:00:00.000Z',
    checkpoints:[], references:[], steps:[{ id:'step-1', sequence:1, route:'test', description:'Finish fix', state:'verified', requiresConfirmation:false, receiptId:null, note:'success', startedAt:'2026-09-26T00:00:00.000Z', completedAt:'2026-09-26T00:01:00.000Z' }], authorization:null,
  };
  const taskRuns = { list() { return [completedRun]; } };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), taskRuns);
  service.checkpoint(root, {
    summary:'Task completed.',
    objective:'Finish memory fix',
    facts:[
      { key:'working.current_task.id', value:'task-done', category:'working_state', confidence:'verified' },
      { key:'working.current_task.status', value:'completed', category:'working_state', confidence:'verified' },
    ],
  });
  const restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.workingState['working.current_task.id'], undefined);
  assert.equal(restored.workingState['working.current_task.status'], undefined);
  assert.equal(restored.workingState['working.last_task.id'], 'task-done');
  assert.equal(restored.workingState['working.last_task.status'], 'completed');
  assert.equal(restored.reconciliation.activeTaskId, null);
  service.close();
});

test('semantic checkpoints sync a bounded latest-state block into project-local memory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-project-sync-'));
  const root = join(dataDir, 'project');
  const calls = [];
  const projects = {
    ...fakeProjects(root),
    syncWorkspaceCheckpoint(inputRoot, payload) {
      calls.push({ inputRoot, payload });
      return { synced:true, sequence:payload.sequence };
    },
  };
  const service = new WorkspaceContextService({ dataDir }, projects);
  service.checkpoint(root, { summary:'Important project milestone.', objective:'Finish project', nextAction:'Review output.' });
  assert.ok(calls.length >= 1);
  assert.equal(calls.at(-1).inputRoot, root);
  assert.equal(calls.at(-1).payload.summary, 'Important project milestone.');
  assert.equal(calls.at(-1).payload.nextAction, 'Review output.');
  service.close();
});

test('reconciler normalizes expired tasks with strong completion evidence and records a clean state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-expired-evidence-'));
  const root = join(dataDir, 'project');
  const expiredRun = {
    id:'task-expired', objective:'Implement Memory V2', root, state:'expired', maxSteps:3, maxRuntimeMs:1000,
    stepCount:1, activeStepId:null, checkpointSequence:0, createdAt:'2026-09-26T00:00:00.000Z',
    updatedAt:'2026-09-26T00:02:00.000Z', deadlineAt:'2026-09-26T00:01:00.000Z',
    checkpoints:[], references:[], steps:[{ id:'step-1', sequence:1, route:'code.patch', description:'Implement Memory V2', state:'verified', requiresConfirmation:false, receiptId:null, note:'Implementation complete; full regression passed.', startedAt:'2026-09-26T00:00:00.000Z', completedAt:'2026-09-26T00:00:50.000Z' }],
  };
  const taskRuns = {
    list() { return [expiredRun]; },
    reconcileExpiredCompletion(id, note) {
      assert.equal(id, 'task-expired');
      assert.match(note, /every recorded terminal step was verified/i);
      expiredRun.state = 'completed';
      expiredRun.checkpointSequence += 1;
      expiredRun.checkpoints.push({ sequence:expiredRun.checkpointSequence, summary:note, nextAction:'', createdAt:'2026-09-26T00:02:01.000Z' });
      return expiredRun;
    },
  };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), taskRuns);
  const stored = service.checkpoint(root, { summary:'Historical task state.' });
  assert.ok(stored.bootstrap.reconciliation.actions.includes('task_state:task-expired:expired->completed'));
  const restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.reconciliation.issues.some((issue) => issue.type === 'expired_with_completion_evidence'), false);
  assert.equal(restored.taskRuns[0].state, 'completed');
  assert.equal(restored.taskRuns[0].effectiveState, 'completed');
  service.close();
});

test('reconciler leaves genuinely incomplete expired tasks unchanged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-expired-incomplete-'));
  const root = join(dataDir, 'project');
  const expiredRun = {
    id:'task-incomplete', objective:'Implement Memory V2', root, state:'expired', maxSteps:3, maxRuntimeMs:1000,
    stepCount:2, activeStepId:null, checkpointSequence:0, createdAt:'2026-09-26T00:00:00.000Z',
    updatedAt:'2026-09-26T00:02:00.000Z', deadlineAt:'2026-09-26T00:01:00.000Z',
    checkpoints:[], references:[], steps:[
      { id:'step-1', sequence:1, route:'code.patch', description:'Implement Memory V2', state:'verified', requiresConfirmation:false, receiptId:null, note:'Patch applied.', startedAt:'2026-09-26T00:00:00.000Z', completedAt:'2026-09-26T00:00:40.000Z' },
      { id:'step-2', sequence:2, route:'test', description:'Run final regression', state:'interrupted', requiresConfirmation:false, receiptId:null, note:'Runtime expired before verification.', startedAt:'2026-09-26T00:00:45.000Z', completedAt:'2026-09-26T00:01:00.000Z' },
    ],
  };
  const taskRuns = {
    list() { return [expiredRun]; },
    reconcileExpiredCompletion() { throw new Error('must not be called'); },
  };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), taskRuns);
  service.checkpoint(root, { summary:'Historical incomplete task state.' });
  const restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.reconciliation.actions.some((action) => action.startsWith('task_state:')), false);
  assert.equal(restored.taskRuns[0].state, 'expired');
  assert.equal(restored.taskRuns[0].effectiveState, 'expired');
  service.close();
});
test('active step description outranks an older durable task next-action during resume', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-active-step-resume-'));
  const root = join(dataDir, 'project');
  const activeRun = {
    id:'task-live', objective:'Verify Memory reliability', root, state:'running', maxSteps:5, maxRuntimeMs:10000,
    stepCount:2, activeStepId:'step-verify', checkpointSequence:1, createdAt:'2026-09-26T00:00:00.000Z',
    updatedAt:'2026-09-26T00:03:00.000Z', deadlineAt:'2026-09-26T01:00:00.000Z',
    checkpoints:[{ sequence:1, summary:'Prepared restart.', nextAction:'Restart runtime again.', createdAt:'2026-09-26T00:01:00.000Z' }],
    references:[],
    steps:[{ id:'step-verify', sequence:2, route:'runtime.verify', description:'Verify the already restarted runtime without replaying restart.', state:'running', requiresConfirmation:false, receiptId:null, note:null, startedAt:'2026-09-26T00:03:00.000Z', completedAt:null }],
    authorization:null,
  };
  const taskRuns = { list() { return [activeRun]; } };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), taskRuns);
  service.checkpoint(root, { summary:'Task resumed after restart.', objective:'Verify Memory reliability' });
  const restored = service.bootstrap(root, { activate:false });
  assert.match(restored.resumePrompt, /Continue active step step-verify: Verify the already restarted runtime without replaying restart/);
  assert.doesNotMatch(restored.resumePrompt, /Restart runtime again/);
  service.close();
});


test('active durable step outranks a stale semantic next action and exposes structured resumeState', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-resume-authority-'));
  const root = join(dataDir, 'project');
  const activeRun = {
    id:'task-live-authority', objective:'Deploy and verify the upgraded runtime', root, state:'running', maxSteps:5, maxRuntimeMs:10000,
    stepCount:2, activeStepId:'step-live-verify', checkpointSequence:1, createdAt:'2026-09-28T00:00:00.000Z',
    updatedAt:'2026-09-28T00:03:00.000Z', deadlineAt:'2026-09-28T01:00:00.000Z',
    checkpoints:[{ sequence:1, summary:'Runtime already restarted.', nextAction:'Verify live v0.13.0 health.', createdAt:'2026-09-28T00:01:00.000Z' }],
    references:[],
    steps:[{ id:'step-live-verify', sequence:2, route:'runtime.verify', description:'Verify live v0.13.0 health without replaying the restart.', state:'running', requiresConfirmation:false, receiptId:null, note:null, startedAt:'2026-09-28T00:03:00.000Z', completedAt:null }],
    authorization:null,
  };
  const taskRuns = { list() { return [activeRun]; } };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), taskRuns);
  service.checkpoint(root, {
    summary:'Older semantic plan before restart.',
    objective:'Deploy and verify the upgraded runtime',
    nextAction:'Restart runtime again even though it is already restarted.',
  });
  const restored = service.bootstrap(root, { activate:false });
  assert.equal(restored.resumeState.status, 'active');
  assert.equal(restored.resumeState.source, 'active_step');
  assert.equal(restored.resumeState.taskId, 'task-live-authority');
  assert.equal(restored.resumeState.stepId, 'step-live-verify');
  assert.match(restored.resumeState.nextAction, /Verify live v0\.13\.0 health without replaying the restart/);
  assert.match(restored.resumePrompt, /Verify live v0\.13\.0 health without replaying the restart/);
  assert.doesNotMatch(restored.resumePrompt, /Restart runtime again even though it is already restarted/);
  service.close();
});


test('project chat journal persists visible user/assistant history and participates in recall', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-project-chat-journal-'));
  const root = join(dataDir, 'project');
  const projects = fakeProjects(root);
  const first = new WorkspaceContextService({ dataDir }, projects);
  first.checkpoint(root, { summary:'TOEIC project active.', objective:'Continue English study.' });
  const stored = first.ingestChatSnapshot('/c/toeic-123', [
    { key:'turn-user-1', ordinal:0, role:'user', content:'Keep the TOEIC headings dark blue and labels teal. password=dummy-secret' },
    { key:'turn-assistant-1', ordinal:1, role:'assistant', content:'I will preserve the established TOEIC formatting.' },
    { key:'turn-system-1', ordinal:2, role:'system', content:'This must never be stored.' },
  ], { pageTitle:'TOEIC Reading', url:'https://chatgpt.com/c/toeic-123', source:'test', focused:true });
  assert.equal(stored.stored, true);
  assert.equal(stored.messagesSeen, 2);
  const history = first.chatHistory(root, '/c/toeic-123', { limit:20, maxChars:20000 });
  assert.equal(history.totalMessages, 2);
  assert.equal(history.messages.some((item) => item.role === 'system'), false);
  assert.equal(history.messages[0].content.includes('[REDACTED]'), true);
  assert.equal(history.messages[0].content.includes('dummy-secret'), false);
  const recall = first.recall(root, 'TOEIC headings dark blue labels teal', 10);
  assert.ok(recall.results.some((item) => item.kind === 'chat.user' && /dark blue/i.test(item.text)));
  const found = first.findProjects('NHD Workstation MCP', 5);
  assert.equal(found.matches[0].root, root);
  first.close();

  const second = new WorkspaceContextService({ dataDir }, projects);
  const restored = second.bootstrap(root, { activate:false, maxChars:30000 });
  assert.equal(restored.chatHistory.totalMessages, 2);
  assert.ok(restored.chatHistory.messages.some((item) => /established TOEIC formatting/i.test(item.content)));
  second.close();
});

test('chat journal ignores unfocused snapshots', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-project-chat-unfocused-'));
  const root = join(dataDir, 'project');
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root));
  service.checkpoint(root, { summary:'Project active.' });
  const stored = service.ingestChatSnapshot('/c/background-tab', [
    { key:'u1', ordinal:0, role:'user', content:'Background tab content' },
  ], { focused:false });
  assert.equal(stored.stored, false);
  assert.equal(service.chatHistory(root).totalMessages, 0);
  service.close();
});






test('conversation binding resolves project and durable task before the global active-project fallback', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-conversation-task-binding-'));
  const root = join(dataDir, 'project');
  const run = {
    id:'task-bound', objective:'Continue MCP architecture work', root, state:'running', maxSteps:10, maxRuntimeMs:600000,
    stepCount:0, activeStepId:null, checkpointSequence:0, createdAt:'2026-10-13T00:00:00.000Z', updatedAt:'2026-10-13T00:00:01.000Z', deadlineAt:'2026-10-13T01:00:00.000Z',
    checkpoints:[], references:[], steps:[], authorization:null,
  };
  const taskRuns = { list() { return [run]; } };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), taskRuns);
  service.bindConversation(root, '/c/mcp-architecture', { pageTitle:'Xem lại kiến trúc MCP', url:'https://chatgpt.com/c/mcp-architecture', source:'test' });
  const bound = service.bindConversationTask('/c/mcp-architecture', 'task-bound', 'test');
  assert.equal(bound.taskId, 'task-bound');
  assert.equal(bound.root, root);
  const restored = service.bootstrap(undefined, { conversationId:'/c/mcp-architecture', activate:false });
  assert.equal(restored.bindingResolution.source, 'conversation_project_task');
  assert.equal(restored.bindingResolution.root, root);
  assert.equal(restored.bindingResolution.taskId, 'task-bound');
  assert.equal(restored.bindingResolution.globalFallbackUsed, false);
  assert.equal(service.stats().bindingModel, 'conversation-project-task');
  assert.equal(service.stats().conversationTaskBindings, 1);
  service.close();
});

test('new focused chat snapshot prefers the unique active durable-task project before legacy global state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-memory-active-task-chat-'));
  const root = join(dataDir, 'project');
  const run = {
    id:'task-live', objective:'Bound active task', root, state:'running', maxSteps:10, maxRuntimeMs:600000,
    stepCount:0, activeStepId:null, checkpointSequence:0, createdAt:'2026-10-13T00:00:00.000Z', updatedAt:'2026-10-13T00:00:01.000Z', deadlineAt:'2026-10-13T01:00:00.000Z',
    checkpoints:[], references:[], steps:[], authorization:null,
  };
  const taskRuns = { list() { return [run]; } };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), taskRuns);
  const result = service.ingestChatSnapshot('/c/new-focus', [{key:'u1',ordinal:1,role:'user',content:'continue MCP'}], {focused:true,pageTitle:'MCP',source:'test'});
  assert.equal(result.stored, true);
  assert.equal(result.root, root);
  assert.equal(result.bindingSource, 'active_task_project');
  const history = service.chatHistory(undefined, '/c/new-focus');
  assert.equal(history.root, root);
  service.close();
});


test('progressive bootstrap preserves authoritative quality while deferring only bulky history', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-progressive-context-'));
  const root = join(dataDir, 'project');
  let readMemoryCalls = 0;
  const baseProjects = fakeProjects(root);
  const projects = {
    ...baseProjects,
    readMemory(input) { readMemoryCalls += 1; return baseProjects.readMemory(input); },
    listDecisions() { return [{id:'decision-1',title:'Keep quality',value:'Never drop authoritative project facts.',status:'confirmed',source:'test',updatedAt:'2026-10-13T00:00:05.000Z'}]; },
  };
  const run = {
    id:'task-progressive', objective:'Continue TOEIC formatting with established colors and structure', root, state:'running', maxSteps:10, maxRuntimeMs:600000,
    stepCount:0, activeStepId:null, checkpointSequence:0, createdAt:'2026-10-13T00:00:00.000Z', updatedAt:'2026-10-13T00:00:10.000Z', deadlineAt:'2026-10-13T01:00:00.000Z',
    checkpoints:[], references:[], steps:[], authorization:null,
  };
  const taskRuns = { list() { return [run]; } };
  const service = new WorkspaceContextService({ dataDir }, projects, taskRuns);
  service.checkpoint(root, {
    summary:'TOEIC project is active and formatting must remain consistent.',
    objective:'Continue TOEIC study.',
    nextAction:'Continue Block B using the established format.',
    facts:[
      {key:'working.current_document.path',value:'D:\\NHD Projects\\TOEIC\\TOEIC.docx',category:'working_state',confidence:'verified'},
      {key:'toeic.format.heading',value:'dark blue',category:'preference',confidence:'confirmed'},
      {key:'toeic.format.label',value:'teal',category:'preference',confidence:'confirmed'},
    ],
  });
  service.ingestChatSnapshot('/c/toeic-progressive', [
    {key:'u1',ordinal:0,role:'user',content:'Keep the TOEIC headings dark blue and labels teal when continuing Block B.'},
    {key:'a1',ordinal:1,role:'assistant',content:'I will preserve that formatting and the established correction structure.'},
    ...Array.from({length:80}, (_,i) => ({key:`old-${i}`,ordinal:i+2,role:i%2?'assistant':'user',content:`Older unrelated project chat line ${i} with verbose historical detail that should not be dumped into every resume.`})),
  ], {focused:true,pageTitle:'TOEIC',source:'test'});
  readMemoryCalls = 0;
  const progressive = service.bootstrap(root, { activate:false, mode:'progressive', query:'continue TOEIC Block B formatting dark blue teal' });
  assert.equal(progressive.contextMode, 'progressive');
  assert.equal(progressive.resumeState.taskId, 'task-progressive');
  assert.equal(progressive.checkpoint.nextAction, 'Continue Block B using the established format.');
  assert.equal(progressive.facts.find((fact) => fact.key === 'toeic.format.heading').value, 'dark blue');
  assert.equal(progressive.facts.find((fact) => fact.key === 'toeic.format.label').value, 'teal');
  assert.equal(progressive.decisions[0].value, 'Never drop authoritative project facts.');
  assert.equal(progressive.qualityGuard.authoritativeCoreComplete, true);
  assert.equal(progressive.hydrationManifest.lossless, true);
  assert.equal(progressive.hydrationManifest.deferredCollections.chatHistory.totalMessages, 82);
  assert.equal(progressive.chatHistory.returnedMessages, 0);
  assert.equal(readMemoryCalls, 0, 'progressive read path must not read bulky legacy memory');
  assert.ok(progressive.relevantContext.results.some((item) => item.kind === 'chat.user' && /dark blue/i.test(item.text)));
  assert.equal(progressive.legacyMemory, '');

  const progressiveSize = JSON.stringify(progressive).length;
  const full = service.bootstrap(root, { activate:false, mode:'full', maxChars:30000 });
  assert.equal(full.contextMode, 'full');
  assert.equal(full.resumeState.taskId, progressive.resumeState.taskId);
  assert.deepEqual(full.checkpoint, progressive.checkpoint);
  assert.deepEqual(full.facts, progressive.facts);
  assert.deepEqual(full.decisions, progressive.decisions);
  assert.ok(full.chatHistory.returnedMessages > 0);
  assert.ok(readMemoryCalls > 0, 'full mode should retain legacy-memory compatibility');
  assert.ok(progressiveSize < JSON.stringify(full).length, 'progressive payload should be smaller without dropping authoritative core');
  service.close();
});

test('auto bootstrap falls back to full context when quality guard detects history-sensitive intent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'nhd-progressive-quality-fallback-'));
  const root = join(dataDir, 'project');
  const run = {
    id:'task-history', objective:'Continue project work', root, state:'running', maxSteps:10, maxRuntimeMs:600000,
    stepCount:0, activeStepId:null, checkpointSequence:0, createdAt:'2026-10-13T00:00:00.000Z', updatedAt:'2026-10-13T00:00:10.000Z', deadlineAt:'2026-10-13T01:00:00.000Z',
    checkpoints:[], references:[], steps:[], authorization:null,
  };
  const service = new WorkspaceContextService({ dataDir }, fakeProjects(root), { list(){ return [run]; } });
  service.checkpoint(root, { summary:'Project active.', nextAction:'Continue work.' });
  service.ingestChatSnapshot('/c/history', [{key:'u1',ordinal:0,role:'user',content:'Old important decision from last time.'}], {focused:true,source:'test'});
  const restored = service.bootstrap(root, { activate:false, mode:'auto', query:'What did we discuss last time before this task?' });
  assert.equal(restored.contextMode, 'full');
  assert.equal(restored.qualityGuard.fallbackToFullWasRequired, true);
  assert.ok(restored.chatHistory.returnedMessages > 0);
  service.close();
});
