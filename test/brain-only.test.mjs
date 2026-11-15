import test from 'node:test';
import assert from 'node:assert/strict';
import { brainOnlyAllows, brainOnlyDenied, isBrainOnlyTransport } from '../dist/brain-only.js';

test('brain-only tool policy allows and denies the expected tools', () => {
  assert.equal(brainOnlyAllows('delegate_task'), true);
  assert.equal(brainOnlyAllows('review_pack'), true);
  assert.equal(brainOnlyAllows('context_bootstrap'), true);
  assert.equal(brainOnlyAllows('task_run'), true);

  assert.equal(brainOnlyAllows('terminal_execute'), false);
  assert.equal(brainOnlyAllows('fs_read'), false);
  assert.equal(brainOnlyAllows('office_read'), false);
});

test('brain-only transport detection requires remote HTTP without an opt-out', () => {
  assert.equal(isBrainOnlyTransport('remote-http', {}), true);
  assert.equal(isBrainOnlyTransport('local-http', {}), false);
  assert.equal(isBrainOnlyTransport('remote-http', { NHD_BRAIN_ONLY: '0' }), false);
});

test('brain-only denial reports the blocked tool', () => {
  const result = brainOnlyDenied('fs_read');
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text.includes('BRAIN_ONLY'), true);
  assert.equal(result.content[0].text.includes('fs_read'), true);
});
