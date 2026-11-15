import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadContextRefs } from '../dist/sbce-context-refs.js';

const root = path.resolve('fakeroot');
const readFile = abs =>
  abs === path.resolve('fakeroot', 'src', 'a.ts')
    ? 'l1\r\nl2\nl3\nl4\n'
    : null;

test('loads a selected line range and normalizes line endings', () => {
  const result = loadContextRefs(root, ['src/a.ts:2-3'], readFile);

  assert.deepEqual(result.errors, []);
  assert.equal(result.evidence[0].snippet, 'l2\nl3');
  assert.equal(result.evidence[0].locator, 'src/a.ts:2-3');
  assert.equal(result.evidence[0].label, 'public/code');
});

test('loads the complete file when no range is provided', () => {
  const result = loadContextRefs(root, ['src/a.ts'], readFile);

  assert.equal(result.evidence[0].snippet, 'l1\nl2\nl3\nl4');
  assert.equal(result.evidence[0].locator, 'src/a.ts:1-4');
});

test('clamps a range to the available lines', () => {
  const result = loadContextRefs(root, ['src/a.ts:3-99'], readFile);

  assert.equal(result.evidence[0].locator, 'src/a.ts:3-4');
});

test('rejects invalid context references', () => {
  const result = loadContextRefs(
    root,
    ['../x.ts', 'C:/x.ts', 'src/a.ts:3-2'],
    readFile
  );

  assert.equal(result.errors.length, 3);
  for (const error of result.errors) {
    assert.match(error, /^SBCE_CONTEXT_REF_INVALID:/);
  }
});

test('reports missing context files', () => {
  const result = loadContextRefs(root, ['src/missing.ts'], readFile);

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^SBCE_CONTEXT_REF_MISSING:/);
});

test('limits the number of context references', () => {
  const result = loadContextRefs(root, Array(13).fill('src/a.ts'), readFile);

  assert.equal(result.evidence.length, 12);
  assert.ok(result.errors.some(error => error.includes('SBCE_CONTEXT_REF_LIMIT')));
});
