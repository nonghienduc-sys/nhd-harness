import test from 'node:test';
import assert from 'node:assert/strict';
import { compactJob } from '../dist/sbce-compact.js';

test('compacts a ready_for_review job with unique failed checks', () => {
  const job = {
    id: 42,
    status: 'ready_for_review',
    attempts: 3,
    spentVnd: 125000,
    review: {
      checks: [
        { name: 'lint', ok: true },
        { name: 'tests', ok: false },
        { name: 'security', ok: false },
        { name: 'tests', ok: false },
      ],
      attempts: [
        { error: '' },
        { error: 'first failure' },
        { error: 'latest failure' },
      ],
      artifacts: { draft: 'artifact.md' },
      summary: 'Review is ready.',
    },
  };

  assert.deepEqual(compactJob(job), {
    job_id: '42',
    status: 'ready_for_review',
    done: true,
    attempts: 3,
    spent_vnd: 125000,
    failed_checks: ['tests', 'security'],
    last_error: 'latest failure',
    artifact: 'artifact.md',
    summary: 'Review is ready.',
    next: compactJob(job).next,
  });
  assert.match(compactJob(job).next, /^Inspect artifact/);
});

test('uses the last non-empty attempt error', () => {
  const job = {
    id: 'brain-1',
    status: 'needs_brain',
    review: {
      attempts: [
        { error: 'earlier error' },
        { error: '   ' },
        {},
      ],
    },
  };

  const compact = compactJob(job);

  assert.equal(compact.last_error, 'earlier error');
  assert.match(compact.next, /^Read last_error/);
});

test('truncates long text to maxText including the ellipsis', () => {
  const compact = compactJob(
    {
      id: 7,
      status: 'ready_for_review',
      review: {
        summary: 'abcdefghijklmnop',
        artifacts: { draft: 'draft content' },
      },
    },
    10,
  );

  assert.equal(compact.summary.length, 10);
  assert.equal(compact.summary, 'abcdefghi…');
  assert.equal(compact.summary.endsWith('…'), true);
});

test('marks every active state as not done', () => {
  for (const status of ['queued', 'running', 'verifying', 'fixing']) {
    const compact = compactJob({ id: status, status });

    assert.equal(compact.status, status);
    assert.equal(compact.done, false);
    assert.match(compact.next, /^Still running/);
  }
});

test('provides action guidance for failed and completed states', () => {
  const failed = compactJob({ id: 1, status: 'failed' });
  const accepted = compactJob({ id: 2, status: 'accepted' });
  const cancelled = compactJob({ id: 3, status: 'cancelled' });

  assert.equal(failed.done, true);
  assert.match(failed.next, /^Read last_error/);
  assert.equal(accepted.next, 'No action needed.');
  assert.equal(cancelled.next, 'No action needed.');
});

test('handles null and empty jobs without throwing', () => {
  assert.doesNotThrow(() => compactJob(null));
  assert.doesNotThrow(() => compactJob({}));

  const empty = compactJob({});
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.done, true);
  assert.deepEqual(empty.failed_checks, []);
  assert.equal(empty.last_error, null);
  assert.equal(empty.artifact, null);
  assert.equal(empty.summary, null);
});

test('defaults review fields when review is absent', () => {
  const compact = compactJob({
    id: 9,
    status: 'running',
    attempts: 2,
    spentVnd: 500,
  });

  assert.equal(compact.job_id, '9');
  assert.equal(compact.attempts, 2);
  assert.equal(compact.spent_vnd, 500);
  assert.deepEqual(compact.failed_checks, []);
  assert.equal(compact.last_error, null);
  assert.equal(compact.artifact, null);
  assert.equal(compact.summary, null);
});
