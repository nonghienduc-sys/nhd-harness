import test from 'node:test';
import assert from 'node:assert/strict';
import { compactCheckpointResult } from '../dist/mcp-registries/context-tools.js';

test('context_checkpoint returns a compact bootstrap summary instead of the full context', () => {
  const big = 'x'.repeat(200_000);
  const stored = { stored: true, root: 'D:/p', sequence: 7, kind: 'semantic', createdAt: 't', projectMemorySync: null,
    bootstrap: { available: true, runtimeVersion: '0.24.15', activeProject: { name: 'P', root: 'D:/p', extra: big }, resumePrompt: 'Resume: ' + big, reconciliation: { actions: ['a1'] }, facts: [{ key: 'k', value: big }] } };
  const out = compactCheckpointResult(stored);
  assert.equal(out.stored, true);
  assert.equal(out.sequence, 7);
  assert.equal(out.bootstrap.omitted, true);
  assert.deepEqual(out.bootstrap.activeProject, { name: 'P', root: 'D:/p' });
  assert.deepEqual(out.bootstrap.reconciliationActions, ['a1']);
  assert.equal(out.bootstrap.facts, undefined);
  assert.ok(JSON.stringify(out).length < 2_000);
  assert.equal(compactCheckpointResult({ stored: true }).stored, true);
});

test('context_checkpoint registry keeps an opt-in for the full bootstrap', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/mcp-registries/context-tools.ts', import.meta.url), 'utf8');
  assert.match(src, /include_bootstrap \? stored : compactCheckpointResult\(stored\)/);
});
