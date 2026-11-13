import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeToolOutput, buildContextHeader, ContextHandshakeService, prependText } from '../dist/output-shaping.js';
import { SERVER_INSTRUCTIONS } from '../dist/server-instructions.js';
import { result } from '../dist/mcp-registries/shared.js';

const out = (value) => ({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

test('task_run keeps only the latest checkpoint except for status', () => {
  const task = { id: 't', checkpoints: [{ sequence: 1, summary: 'a'.repeat(3000) }, { sequence: 2, summary: 'b' }] };
  const shaped = shapeToolOutput('task_run', { action: 'start' }, out(task));
  assert.equal(shaped.structuredContent.checkpoints.length, 1);
  assert.equal(shaped.structuredContent.checkpoints[0].sequence, 2);
  assert.equal(shaped.structuredContent.checkpointCount, 2);
  assert.ok(shaped.content[0].text.length < 600);
  const status = shapeToolOutput('task_run', { action: 'status' }, out(task));
  assert.equal(status.structuredContent.checkpoints.length, 2);
});

test('runtime_identity drops the static authority block', () => {
  const shaped = shapeToolOutput('runtime_identity', {}, out({ productionVersion: '0.24.14', authority: { a: 'x'.repeat(500) }, release: { previous: { id: 'p', version: '1', path: 'P', sourceHash: 'h' } } }));
  assert.equal('authority' in shaped.structuredContent, false);
  assert.deepEqual(shaped.structuredContent.release.previous, { id: 'p', version: '1', path: 'P' });
});

test('governor plan keeps the most relevant facts only', () => {
  const facts = Array.from({ length: 10 }, (_, i) => ({ key: 'video.' + i, value: 'mp4 render ' + i, category: 'artifact' }));
  facts.push({ key: 'harness.release', value: 'Harness cutover release v0.24.14', category: 'working_state' });
  const shaped = shapeToolOutput('tool_governor', { action: 'plan', text: 'Harness release cutover' }, out({ taskClass: 'mcp_development', memoryPack: { projectFacts: facts, similarTasks: [1, 2, 3, 4, 5].map((i) => ({ id: 't' + i, summary: 's'.repeat(2000) })) } }));
  assert.equal(shaped.structuredContent.memoryPack.projectFacts.length, 5);
  assert.equal(shaped.structuredContent.memoryPack.projectFacts[0].key, 'harness.release');
  assert.equal(shaped.structuredContent.memoryPack.projectFactsOmitted, 6);
  assert.equal(shaped.structuredContent.memoryPack.similarTasks.length, 3);
});

test('errors and unknown tools pass through untouched', () => {
  const error = { isError: true, content: [{ type: 'text', text: 'boom' }] };
  assert.equal(shapeToolOutput('task_run', {}, error), error);
  const other = out({ x: 1 });
  assert.equal(shapeToolOutput('fs_read', {}, other), other);
});

test('context header is compact and handshake fires once per idle window', () => {
  const boot = { available: true, activeProject: { name: 'Nâng cấp Harness NHD', root: 'D:/NHD Projects/Nâng cấp Harness NHD' }, resume: { taskId: 'task-1', taskState: 'running', objective: 'o'.repeat(3000), nextAction: 'cutover v0.24.14' } };
  const header = buildContextHeader(boot, 'Claude-User');
  assert.match(header, /NHD context/);
  assert.match(header, /Task: task-1 \(running\)/);
  assert.match(header, /Next: cutover v0\.24\.14/);
  assert.ok(header.length <= 2001);
  assert.equal(buildContextHeader({ available: false }, 'x'), null);
  let builds = 0;
  const hs = new ContextHandshakeService(() => { builds += 1; return 'H'; }, 1000);
  assert.equal(hs.take('k', 'a', 0), 'H');
  assert.equal(hs.take('k', 'a', 500), null);
  assert.equal(hs.take('k', 'a', 2000), 'H');
  hs.markSeen('k2', 0);
  assert.equal(hs.take('k2', 'a', 10), null);
  assert.equal(builds, 2);
  const prepended = prependText({ content: [{ type: 'text', text: 'body' }] }, 'H');
  assert.equal(prepended.content[0].text, 'H');
  assert.equal(prepended.content[1].text, 'body');
});

test('server instructions are short, client-neutral and keep the mandatory gates', () => {
  assert.ok(SERVER_INSTRUCTIONS.length < 4200, 'length ' + SERVER_INSTRUCTIONS.length);
  assert.equal(/ChatGPT/.test(SERVER_INSTRUCTIONS), false);
  for (const must of ['context_bootstrap', 'CONFIRM CRITICAL', 'office_admin_release_prepare', 'office_admin_release_view_page', 'hard-denied', 'IEX', 'isolated_', 'project_rag_query', 'context_payload_artifact', 'QA2']) {
    assert.ok(SERVER_INSTRUCTIONS.includes(must), 'missing ' + must);
  }
});

test('result() emits compact JSON text', () => {
  const r = result({ a: 1, b: [1, 2] });
  assert.equal(r.content[0].text, '{"a":1,"b":[1,2]}');
});
