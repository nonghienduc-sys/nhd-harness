import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecallFreshness, recallWantsCurrent } from '../dist/workspace-memory.js';
import { recallEvidenceText } from '../dist/result-payload-gateway.js';

const now = Date.parse('2026-11-12T00:00:00Z');
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

test('current-state queries are detected (with Vietnamese diacritics)', () => {
  assert.equal(recallWantsCurrent('trạng thái hiện tại của Harness'), true);
  assert.equal(recallWantsCurrent('latest release'), true);
  assert.equal(recallWantsCurrent('quy tắc viết khóa luận'), false);
});

test('fresh items outrank stale items with equal keyword score', () => {
  const items = [
    { score: 26, updatedAt: daysAgo(20), text: 'roadmap v0.23.9 old' },
    { score: 22, updatedAt: daysAgo(0), text: 'production v0.24.12 current' },
  ];
  const ranked = applyRecallFreshness(items, 'trạng thái hiện tại', now);
  assert.equal(ranked[0].text, 'production v0.24.12 current');
});

test('duplicate text keeps only the newest copy', () => {
  const items = [
    { score: 10, updatedAt: daysAgo(3), text: 'Đợt 1 nâng cấp Harness' },
    { score: 10, updatedAt: daysAgo(0), text: 'Đợt 1 nâng cấp Harness' },
    { score: 5, updatedAt: daysAgo(0), text: 'khác' },
  ];
  const ranked = applyRecallFreshness(items, 'nâng cấp', now);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].updatedAt, daysAgo(0));
});

test('facts with different keys but identical values are deduplicated', () => {
  const items = [
    { score: 10, updatedAt: daysAgo(0), text: 'working.current_task.objective = Đợt 1 nâng cấp Harness working_state' },
    { score: 10, updatedAt: daysAgo(0), text: 'workspace.current_objective = Đợt 1 nâng cấp Harness working_state' },
  ];
  assert.equal(applyRecallFreshness(items, 'nâng cấp', now).length, 1);
});

test('recall evidence text lists top items compactly', () => {
  const text = recallEvidenceText({ results: [
    { kind: 'fact', id: 'a', updatedAt: '2026-11-12T00:00:00Z', text: 'x'.repeat(1000) },
    { kind: 'chat.user', id: 'b', updatedAt: '2026-11-11T00:00:00Z', text: 'ngắn' },
  ] });
  assert.match(text, /^\[1\] fact a \(2026-11-12\): x+…$/m);
  assert.match(text, /\[2\] chat\.user b \(2026-11-11\): ngắn/);
  assert.ok(text.length < 700);
});
